/**
 * Proxy-aware HTTP transport shared by the chat providers (Codex/Gemini) and
 * the audio generators (Stable Audio / ElevenLabs / MiniMax).
 *
 * chatgpt.com / api.openai.com / generativelanguage.googleapis.com are often
 * reachable only through a local proxy, and Node's fetch ignores macOS system
 * proxy settings — so those calls go through this helper (CONNECT tunnel)
 * instead. The Anthropic chat path keeps using plain fetch.
 *
 * http:// targets (localhost self-hosted servers, mock servers in tests) go
 * direct without TLS or proxying.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import * as net from "node:net";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { detectSystemProxy } from "./paths.js";

let cachedProxy: string | null | undefined;

export function detectProxy(): string | null {
  if (cachedProxy !== undefined) return cachedProxy;
  const env =
    process.env.AIBLETON_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (env) {
    cachedProxy = env;
    return env;
  }
  cachedProxy = detectSystemProxy();
  return cachedProxy;
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: AsyncIterable<Buffer>;
}

interface RawInit {
  headers: Record<string, string>;
  body?: string;
  proxy: string | null;
  signal?: AbortSignal;
}

/** Minimal HTTP(S) request with optional HTTP-proxy CONNECT tunneling. */
export function rawRequest(
  method: "GET" | "POST",
  target: URL,
  init: RawInit,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Abort support: destroy whatever is in flight. Before the response
    // arrives that makes this promise reject; after, it kills the body
    // stream so the caller's read loop throws.
    let current: { destroy: () => void } | null = null;
    const cleanup = () => init.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      current?.destroy();
      cleanup();
      reject(new Error("请求已停止"));
    };
    if (init.signal) {
      if (init.signal.aborted) {
        reject(new Error("请求已停止"));
        return;
      }
      init.signal.addEventListener("abort", onAbort);
    }
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const send = (socket?: tls.TLSSocket) => {
      const reqOpts: https.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + target.search,
        method,
        headers: {
          ...(typeof init.body === "string"
            ? { "content-length": String(Buffer.byteLength(init.body)) }
            : {}),
          ...init.headers,
        },
      };
      // Request-level createConnection (no `agent` key at all — passing
      // agent:false makes Node ignore it and dial the target directly).
      if (socket) reqOpts.createConnection = () => socket;
      // http:// targets (localhost self-hosted / mock servers): plain http,
      // no TLS, no proxy.
      const transport = target.protocol === "http:" ? http : https;
      const req = transport.request(reqOpts, (res) => {
        current = req;
        res.on("close", cleanup);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      });
      current = req;
      req.on("error", fail);
      if (typeof init.body === "string") req.write(init.body);
      req.end();
    };
    if (!init.proxy || target.protocol === "http:") {
      send();
      return;
    }
    let proxy: URL;
    try {
      proxy = new URL(init.proxy);
    } catch {
      fail(new Error(`代理地址无效: ${init.proxy}`));
      return;
    }
    const proxySocket = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      proxySocket.write(
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n${auth}\r\n`,
      );
    });
    current = proxySocket;
    proxySocket.setTimeout(15000, () => {
      proxySocket.destroy();
      fail(new Error(`代理连接超时 (${proxy.host})`));
    });
    let head = "";
    proxySocket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const endIdx = head.indexOf("\r\n\r\n");
      if (endIdx < 0) return;
      proxySocket.removeListener("data", onData);
      proxySocket.setTimeout(0);
      if (!/^HTTP\/\d(?:\.\d)? 200/.test(head)) {
        proxySocket.destroy();
        fail(new Error(`代理 CONNECT 失败: ${head.slice(0, head.indexOf("\r\n"))}`));
        return;
      }
      const secure = tls.connect(
        { socket: proxySocket, servername: target.hostname, ALPNProtocols: ["http/1.1"] },
        () => send(secure),
      );
      current = secure;
      secure.on("error", fail);
    });
    proxySocket.on("error", fail);
  });
}

export function rawPost(
  target: URL,
  init: RawInit & { body: string },
): Promise<RawResponse> {
  return rawRequest("POST", target, init);
}

export function rawGet(target: URL, init: RawInit): Promise<RawResponse> {
  return rawRequest("GET", target, init);
}

export async function readAll(stream: AsyncIterable<Buffer>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString("utf8");
  return out;
}

export async function readAllBinary(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
