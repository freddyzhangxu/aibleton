/**
 * Ableton Move Manager HTTP client — talks to the STOCK firmware's web API
 * (no SSH / community hacks needed). Endpoint surface reverse-engineered from
 * the Move Manager frontend bundle the device itself serves:
 *
 *   POST /api/v1/challenge            {} → shows a 6-digit code on the display
 *   POST /api/v1/challenge-response   {"secret":"123456"} → token cookie
 *   GET  /api/v1/system/version       firmware version
 *   GET  /api/v1/data/Sets            list Sets ({objects:[...]})
 *   GET  /api/v1/data/Sets/{id}       download a Set (.ablbundle)
 *   GET  /api/v1/files/               list root folders ({paths:[...]})
 *   GET  /api/v1/files/{dir…}         list a folder / download a file
 *   POST /api/v1/files/{dir…}         multipart upload (?overwrite=bool)
 *
 * Everything except the pairing handshake needs the
 * Ableton-Challenge-Response-Token cookie. Path segments are each
 * encodeURIComponent'd, mirroring the frontend's own encoding.
 */

import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { rawGet, rawPost, readAll, readAllBinary } from "./http.js";
import { readHomeBinary } from "./paths.js";

export interface MoveConfig {
  host?: string;
  token?: string;
}

const DEFAULT_HOST = "move.local";
const COOKIE_NAME = "Ableton-Challenge-Response-Token";

export class MoveError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export function moveHost(cfg: MoveConfig): string {
  return (cfg.host || DEFAULT_HOST).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function moveUrl(cfg: MoveConfig, apiPath: string): URL {
  return new URL(`http://${moveHost(cfg)}${apiPath}`);
}

/** Per-segment encodeURIComponent, like the frontend's own path encoder. */
function encPath(p: string): string {
  return p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** AbortController + setTimeout — the sandbox-safe pattern from websearch.ts
 * (a bare AbortSignal.timeout would crash the Extension Host). */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

interface MoveReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

async function request(
  cfg: MoveConfig,
  method: "GET" | "POST",
  apiPath: string,
  opts: { jsonBody?: unknown; rawBody?: Buffer; contentType?: string; timeoutMs?: number } = {},
): Promise<MoveReply> {
  const url = moveUrl(cfg, apiPath);
  const headers: Record<string, string> = {};
  if (cfg.token) headers["Cookie"] = `${COOKIE_NAME}=${cfg.token}`;
  let body: string | Buffer | undefined;
  if (opts.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.jsonBody);
  } else if (opts.rawBody !== undefined) {
    headers["Content-Type"] = opts.contentType || "application/octet-stream";
    body = opts.rawBody;
  }
  const dl = deadline(opts.timeoutMs ?? 15000);
  try {
    const init = { headers, body, proxy: null, signal: dl.signal };
    const res = method === "POST" ? await rawPost(url, init as { headers: Record<string, string>; body: string | Buffer; proxy: null; signal: AbortSignal }) : await rawGet(url, init);
    const text = await readAll(res.stream);
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("请求已停止")) throw new MoveError(`Move 无响应（超时）— 检查 ${moveHost(cfg)} 是否在同一网络`);
    throw new MoveError(`连不上 Move（${moveHost(cfg)}）：${msg} — 确认设备已开机且与电脑在同一 WiFi`);
  } finally {
    dl.done();
  }
}

/** Throw a MoveError with the server's own message when status ≥ 400. */
function ensureOk(reply: MoveReply, what: string): void {
  if (reply.status < 400) return;
  let detail = "";
  try {
    const data = JSON.parse(reply.text);
    detail = data?.error || data?.files?.[0]?.error || "";
  } catch {
    /* non-JSON error body */
  }
  if (reply.status === 401) {
    throw new MoveError(`${what}失败：未配对或配对已过期 — 请重新 move_pair`, 401);
  }
  throw new MoveError(`${what}失败（HTTP ${reply.status}）${detail ? `：${detail}` : ""}`, reply.status);
}

function parseJson(reply: MoveReply): Record<string, unknown> {
  try {
    return JSON.parse(reply.text) as Record<string, unknown>;
  } catch {
    throw new MoveError(`Move 返回了无法解析的响应（HTTP ${reply.status}）`, reply.status);
  }
}

// ---------- Pairing ----------

/** Step 1: ask the Move to show a 6-digit code on its display. */
export async function pairStart(cfg: MoveConfig): Promise<void> {
  const reply = await request({ ...cfg, token: undefined }, "POST", "/api/v1/challenge", {
    jsonBody: {},
  });
  ensureOk(reply, "发起配对");
}

/** Step 2: exchange the displayed code for an auth token. */
export async function pairComplete(cfg: MoveConfig, code: string): Promise<string> {
  const reply = await request({ ...cfg, token: undefined }, "POST", "/api/v1/challenge-response", {
    jsonBody: { secret: code.trim() },
  });
  if (reply.status === 401) {
    throw new MoveError("配对码不正确 — 请核对 Move 屏幕上的 6 位数字后重试", 401);
  }
  ensureOk(reply, "配对");
  // Prefer the JSON body's token; fall back to parsing Set-Cookie.
  let token = "";
  try {
    token = String((JSON.parse(reply.text) as { token?: string }).token || "");
  } catch {
    /* body not JSON */
  }
  if (!token) {
    const raw = reply.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const c of cookies) {
      const m = c.match(new RegExp(`${COOKIE_NAME}=([0-9a-f]+)`, "i"));
      if (m) {
        token = m[1];
        break;
      }
    }
  }
  if (!token) throw new MoveError("配对成功但未拿到令牌 — 请重试");
  return token;
}

// ---------- Status ----------

export async function systemVersion(cfg: MoveConfig): Promise<Record<string, unknown>> {
  const reply = await request(cfg, "GET", "/api/v1/system/version");
  ensureOk(reply, "读取固件版本");
  return parseJson(reply);
}

// ---------- Sets (data API) ----------

export interface MoveSetInfo {
  id: string;
  name: string;
  [key: string]: unknown;
}

export async function listSets(cfg: MoveConfig): Promise<MoveSetInfo[]> {
  const reply = await request(cfg, "GET", "/api/v1/data/Sets");
  ensureOk(reply, "列出 Set");
  const data = parseJson(reply);
  const objects = Array.isArray(data.objects) ? data.objects : [];
  return objects.map((o: Record<string, unknown>) => ({
    ...o,
    id: String(o.id ?? o.objectId ?? ""),
    name: String(o.name ?? o.id ?? "(未命名)"),
  })) as MoveSetInfo[];
}

/** Download a Set as .ablbundle. */
export async function downloadSet(
  cfg: MoveConfig,
  setId: string,
): Promise<{ filename: string; data: Buffer }> {
  const url = moveUrl(cfg, `/api/v1/data/Sets/${encodeURIComponent(setId)}`);
  const headers: Record<string, string> = {};
  if (cfg.token) headers["Cookie"] = `${COOKIE_NAME}=${cfg.token}`;
  const dl = deadline(120000);
  try {
    const res = await rawGet(url, { headers, proxy: null, signal: dl.signal });
    if (res.status === 401) throw new MoveError("下载 Set 失败：未配对或配对已过期 — 请重新 move_pair", 401);
    if (res.status >= 400) throw new MoveError(`下载 Set 失败（HTTP ${res.status}）`, res.status);
    const data = await readAllBinary(res.stream);
    let filename = `${setId}.ablbundle`;
    const cd = res.headers["content-disposition"];
    const m = typeof cd === "string" && cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (m) filename = decodeURIComponent(m[1].replace(/"$/, ""));
    return { filename, data };
  } finally {
    dl.done();
  }
}

// ---------- Files (samples/recordings API) ----------

export interface MoveFileEntry {
  path: string;
  isDirectory?: boolean;
  size?: number;
  [key: string]: unknown;
}

export async function listFiles(cfg: MoveConfig, dir?: string): Promise<MoveFileEntry[]> {
  const apiPath = dir ? `/api/v1/files/${encPath(dir)}` : "/api/v1/files/";
  const reply = await request(cfg, "GET", apiPath);
  ensureOk(reply, dir ? `列出 ${dir}` : "列出根目录");
  const data = parseJson(reply);
  if (!Array.isArray(data.paths)) return [];
  // Real-device quirk (fw 2.1): the ROOT listing URL-encodes names with spaces
  // ("Track%20Presets") while subfolder listings return them raw. Decode so the
  // model always sees clean names — encPath re-encodes on the next call.
  return (data.paths as MoveFileEntry[]).map((e) => ({
    ...e,
    path: (() => {
      try {
        return decodeURIComponent(e.path);
      } catch {
        return e.path;
      }
    })(),
  }));
}

function multipartBody(field: string, filename: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----aibleton-move-${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Upload a local audio file into a folder on the Move (default: Samples). */
export async function uploadFile(
  cfg: MoveConfig,
  localPath: string,
  folder = "Samples",
  overwrite = false,
): Promise<{ uploaded: string; folder: string; size: number }> {
  const data = readHomeBinary(localPath);
  if (!data) throw new MoveError(`读不到本地文件：${localPath}`);
  const filename = localPath.split(/[\\/]/).pop() || "sample.wav";
  const { body, contentType } = multipartBody("file", filename, data);
  const reply = await request(
    cfg,
    "POST",
    `/api/v1/files/${encPath(folder)}?overwrite=${overwrite ? "true" : "false"}`,
    { rawBody: body, contentType, timeoutMs: 180000 },
  );
  ensureOk(reply, `上传 ${filename}`);
  return { uploaded: filename, folder, size: data.length };
}
