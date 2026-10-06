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
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { detectSystemProxy } from "./paths.js";

const NativeResponse = (globalThis as { Response?: typeof Response }).Response;

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
  body?: string | Buffer;
  proxy: string | null;
  signal?: AbortSignal;
}

/**
 * Keep-alive agents cached per (proxy, origin). Agent-loop providers fire one
 * request per round — each used to pay a full TCP+TLS (+proxy CONNECT)
 * handshake, 0.5–2s through a local proxy, on EVERY round. Pooled agents skip
 * the handshake whenever a free socket survives from the previous round.
 *
 * The proxy case works by overriding the agent's OWN createConnection: the
 * callback form lets the CONNECT+TLS handshake finish asynchronously before
 * the agent gets its socket. (The old pitfall — an explicit `agent` key makes
 * Node ignore a REQUEST-level createConnection — does not apply here, since
 * the tunnel factory now lives on the agent itself.)
 */
const agents = new Map<string, http.Agent>();
const proxyAgentsBySignal = new WeakMap<AbortSignal, Map<string, http.Agent>>();

function agentKey(target: URL, proxy: string | null): string {
  const useProxy = proxy && target.protocol !== "http:";
  return `${useProxy ? proxy : "direct"}|${target.protocol}//${target.host}`;
}

function agentFor(target: URL, proxy: string | null, signal?: AbortSignal): http.Agent {
  const useProxy = proxy && target.protocol !== "http:";
  const key = agentKey(target, proxy);
  let scopedAgents: Map<string, http.Agent> | undefined;
  if (useProxy && signal) {
    scopedAgents = proxyAgentsBySignal.get(signal);
    if (!scopedAgents) {
      scopedAgents = new Map();
      proxyAgentsBySignal.set(signal, scopedAgents);
    }
  }
  const cache = scopedAgents ?? agents;
  const cached = cache.get(key);
  if (cached) return cached;
  const transport = target.protocol === "http:" ? http : https;
  const agent: http.Agent = new transport.Agent({
    keepAlive: true,
    maxSockets: 4,
  });
  if (useProxy) {
    agent.createConnection = ((_options: unknown, oncreate: (err: Error | null, socket?: tls.TLSSocket) => void) => {
      tunnelThroughProxy(proxy, target, signal).then(
        (socket) => oncreate(null, socket),
        (err: Error) => oncreate(err),
      );
      // Returning undefined tells the agent to wait for the callback.
      return undefined as unknown as tls.TLSSocket;
    }) as typeof agent.createConnection;
  }
  cache.set(key, agent);
  return agent;
}

function discardScopedProxyAgent(
  target: URL,
  proxy: string | null,
  signal: AbortSignal | undefined,
  agent: http.Agent | null,
): void {
  if (!signal || !agent || !proxy || target.protocol === "http:") return;
  const scoped = proxyAgentsBySignal.get(signal);
  const key = agentKey(target, proxy);
  if (scoped?.get(key) !== agent) return;
  scoped.delete(key);
  if (!scoped.size) proxyAgentsBySignal.delete(signal);
}

/** CONNECT to the proxy, then TLS over the tunnel — resolves once the secure
 * socket is ready to carry plain HTTP/1.1. */
function tunnelThroughProxy(proxyUrl: string, target: URL, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("请求已停止"));
      return;
    }
    let proxy: URL;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new Error(`代理地址无效: ${proxyUrl}`));
      return;
    }
    let proxySocket: net.Socket | null = null;
    let secureSocket: tls.TLSSocket | null = null;
    let tlsTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (tlsTimer) clearTimeout(tlsTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      secureSocket?.destroy();
      if (!secureSocket) proxySocket?.destroy();
      reject(err);
    };
    const onAbort = () => fail(new Error("请求已停止"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const onProxyError = (err: Error) => fail(err);
    const onSecureError = (err: Error) => fail(err);
    const socket = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n${auth}\r\n`,
      );
    });
    proxySocket = socket;
    socket.setTimeout(15000, () => fail(new Error(`代理连接超时 (${proxy.host})`)));
    let head = "";
    socket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const endIdx = head.indexOf("\r\n\r\n");
      if (endIdx < 0) return;
      socket.removeListener("data", onData);
      socket.setTimeout(0);
      if (!/^HTTP\/\d(?:\.\d)? 200/.test(head)) {
        fail(new Error(`代理 CONNECT 失败: ${head.slice(0, head.indexOf("\r\n"))}`));
        return;
      }
      secureSocket = tls.connect(
        { socket, servername: target.hostname, ALPNProtocols: ["http/1.1"] },
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.removeListener("error", onProxyError);
          secureSocket?.removeListener("error", onSecureError);
          resolve(secureSocket!);
        },
      );
      tlsTimer = setTimeout(() => fail(new Error(`TLS 握手超时 (${target.host})`)), 15000);
      secureSocket.on("error", onSecureError);
    });
    socket.on("error", onProxyError);
  });
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
    let requestAgent: http.Agent | null = null;
    const cleanup = () => init.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      current?.destroy();
      if (init.proxy && target.protocol !== "http:" && init.signal) {
        requestAgent?.destroy();
        discardScopedProxyAgent(target, init.proxy, init.signal, requestAgent);
      }
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
    requestAgent = agentFor(target, init.proxy, init.signal);
    const reqOpts: https.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: target.pathname + target.search,
      method,
      agent: requestAgent,
      headers: {
        ...(init.body !== undefined
          ? {
              "content-length": String(
                Buffer.isBuffer(init.body) ? init.body.length : Buffer.byteLength(init.body),
              ),
            }
          : {}),
        ...init.headers,
      },
    };
    // http:// targets (localhost self-hosted / mock servers): plain http,
    // no TLS, no proxying.
    const transport = target.protocol === "http:" ? http : https;
    let attempts = 0;
    const send = () => {
      attempts++;
      const req = transport.request(reqOpts, (res) => {
        current = req;
        res.on("close", cleanup);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      });
      current = req;
      req.on("error", (err: NodeJS.ErrnoException) => {
        // GET is safe to replay after a connection reset. A POST may already
        // have been processed by the server even when its response connection
        // resets, so retrying it can duplicate paid generations or side effects.
        const stale = err.code === "ECONNRESET" || err.code === "EPIPE";
        if (method === "GET" && stale && attempts === 1 && !init.signal?.aborted) {
          send();
          return;
        }
        fail(err);
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    };
    send();
  });
}

export function rawPost(
  target: URL,
  init: RawInit & { body: string | Buffer },
): Promise<RawResponse> {
  return rawRequest("POST", target, init);
}

export function rawGet(target: URL, init: RawInit): Promise<RawResponse> {
  return rawRequest("GET", target, init);
}

/** Read a response stream as UTF-8 text. A naive `chunk.toString("utf8")`
 * concat corrupts multi-byte characters split across chunk boundaries (CJK
 * search pages, localized API errors) — the native Response decodes across
 * boundaries, and the StringDecoder fallback does the same on older Live
 * runtimes. No mid-flight fallback: if native consumption fails the error
 * propagates rather than silently returning partial text. */
export async function readAll(stream: AsyncIterable<Buffer>): Promise<string> {
  if (
    typeof NativeResponse === "function" &&
    stream instanceof Readable &&
    typeof Readable.toWeb === "function"
  ) {
    return new NativeResponse(Readable.toWeb(stream) as ReadableStream).text();
  }
  const dec = new StringDecoder("utf8");
  let out = "";
  for await (const chunk of stream) out += dec.write(chunk);
  return out + dec.end();
}

export async function readAllBinary(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
