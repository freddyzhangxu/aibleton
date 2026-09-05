/**
 * AI audio generation providers (Stable Audio / ElevenLabs / MiniMax).
 *
 * All three are SYNCHRONOUS APIs (researched 2026-09, official docs):
 * one POST holds the connection until the render finishes, then returns
 *   - Stable Audio: audio bytes            (multipart in, accept: audio/*)
 *   - ElevenLabs:   audio bytes (mp3)      (JSON in, xi-api-key header)
 *   - MiniMax:      JSON with hex audio    (JSON in, Bearer auth)
 * MiniMax may occasionally answer `data.status: 1` (still rendering) on the
 * non-stream path — the adapter then re-POSTs the same request, which is the
 * async/poll escape hatch future providers (Suno-style submit→poll) will
 * generalize.
 *
 * Endpoint notes:
 *   - Stability serves Stable Audio 2.5 behind the "stable-audio-2" path —
 *     the versioned 2.5 path 404s (probed 2026-09).
 *   - MiniMax `instrumental: true` = no vocals and `lyrics` becomes optional;
 *     with vocals, music-3.0 REQUIRES lyrics. A DAW assistant defaults to
 *     instrumental whenever no lyrics are supplied.
 */

import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import {
  AUDIO_EXT,
  mkdirOutsideSandbox,
  resolveAbletonLibraryPaths,
  writeHomeBinary,
} from "./paths.js";
import { detectProxy, rawGet, rawPost, readAll, readAllBinary } from "./http.js";

export type AudioProvider = "stable-audio" | "elevenlabs" | "minimax" | "custom";

export const AUDIO_PROVIDER_NAMES: Record<AudioProvider, string> = {
  "stable-audio": "Stable Audio",
  elevenlabs: "ElevenLabs",
  minimax: "MiniMax",
  custom: "Custom (HTTP)",
};

const AUDIO_PROVIDER_DEFAULTS: Record<Exclude<AudioProvider, "custom">, { base: string; env: string }> = {
  "stable-audio": { base: "https://api.stability.ai", env: "STABILITY_API_KEY" },
  elevenlabs: { base: "https://api.elevenlabs.io", env: "ELEVENLABS_API_KEY" },
  minimax: { base: "https://api.minimaxi.com", env: "MINIMAX_API_KEY" },
};

/**
 * User-defined HTTP audio API (Settings → Audio Generation → Custom).
 * Covers relays, self-hosted MusicGen and Suno-style services:
 *   - submit: POST baseUrl with bodyTemplate ({{prompt}} / {{duration}})
 *   - sync responses: raw bytes, or JSON with a url / base64 / hex field
 *   - async responses: submit returns a task id → poll pollUrl ({taskId})
 *     until pollStatusPath equals pollDoneValue, then download pollAudioPath
 */
export interface CustomAudioTemplate {
  authHeader?: "bearer" | "x-api-key" | "none";
  bodyTemplate?: string;
  responseType?: "bytes" | "url" | "base64" | "hex";
  /** Dot path to the audio field in a JSON response (url/base64/hex types). */
  audioPath?: string;
  /** File extension for base64/hex payloads and bytes without a content-type. */
  format?: string;
  pollUrl?: string;
  pollTaskId?: string;
  pollStatusPath?: string;
  pollDoneValue?: string;
  pollAudioPath?: string;
}

export interface AudioGenConfig {
  provider: AudioProvider;
  apiKey: string;
  baseUrl: string;
  custom?: CustomAudioTemplate;
}

export interface AudioRequestConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  custom?: CustomAudioTemplate;
}

export function resolveAudioConfig(audio?: AudioRequestConfig): AudioGenConfig | null {
  if (audio?.provider === "custom") {
    // The key is optional for custom endpoints; the request URL is required
    // and validated when generating (clearer error than a generic "no key").
    return {
      provider: "custom",
      apiKey: audio.apiKey || "",
      baseUrl: (audio.baseUrl || "").replace(/\/$/, ""),
      custom: audio.custom ?? {},
    };
  }
  const provider: AudioProvider =
    audio?.provider === "elevenlabs" || audio?.provider === "minimax"
      ? audio.provider
      : "stable-audio";
  const defaults = AUDIO_PROVIDER_DEFAULTS[provider];
  const apiKey = audio?.apiKey || process.env[defaults.env] || "";
  if (!apiKey) return null;
  const baseUrl = (audio?.baseUrl || defaults.base).replace(/\/$/, "");
  return { provider, apiKey, baseUrl };
}

/** Env var name for the provider's key — used in the "no key configured" hint. */
export function audioProviderEnv(provider: AudioProvider): string {
  return provider === "custom" ? "(custom 无需环境变量)" : AUDIO_PROVIDER_DEFAULTS[provider].env;
}

export interface GenerateOptions {
  prompt: string;
  seconds: number;
  /** Guarantee no vocals (ElevenLabs force_instrumental / MiniMax instrumental). */
  instrumental?: boolean;
  /** Vocal lyrics (MiniMax music-3.0 with vocals requires them). */
  lyrics?: string;
}

export async function generateAudio(
  cfg: AudioGenConfig,
  opts: GenerateOptions,
  signal?: AbortSignal,
): Promise<string> {
  switch (cfg.provider) {
    case "elevenlabs":
      return genElevenLabs(cfg, opts, signal);
    case "minimax":
      return genMiniMax(cfg, opts, signal);
    case "custom":
      return genCustom(cfg, opts, signal);
    default:
      return genStableAudio(cfg, opts, signal);
  }
}

// ---------- Stable Audio (sync, multipart → wav bytes) ----------

/** multipart/form-data body for Stability's API (text fields only). */
function multipartBody(fields: Record<string, string>): { body: string; contentType: string } {
  const boundary = "----aibleton" + Math.random().toString(36).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  return { body: body + `--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function genStableAudio(
  cfg: AudioGenConfig,
  opts: GenerateOptions,
  signal?: AbortSignal,
): Promise<string> {
  const { body, contentType } = multipartBody({
    prompt: opts.prompt,
    duration: String(opts.seconds),
    output_format: "wav",
  });
  const res = await rawPost(new URL(`${cfg.baseUrl}/v2beta/audio/stable-audio-2/text-to-audio`), {
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      accept: "audio/*",
      "content-type": contentType,
    },
    body,
    proxy: detectProxy(),
    signal,
  });
  if (res.status < 200 || res.status >= 300) {
    const errText = await readAll(res.stream);
    let msg = errText.slice(0, 300);
    try {
      const parsed = JSON.parse(errText) as { errors?: string[]; message?: string };
      msg = parsed.errors?.join("; ") || parsed.message || msg;
    } catch {
      // Not JSON — keep the raw excerpt.
    }
    throw new Error(`Stable Audio API 错误 (${res.status}): ${msg}`);
  }
  const audio = await readAllBinary(res.stream);
  if (!audio.length) throw new Error("Stable Audio 返回了空音频");
  return saveGeneratedAudio(audio, "wav");
}

// ---------- ElevenLabs Music (sync, JSON → mp3 bytes) ----------

async function genElevenLabs(
  cfg: AudioGenConfig,
  opts: GenerateOptions,
  signal?: AbortSignal,
): Promise<string> {
  // API bounds: 3 000–600 000 ms; the tool caps at 190 s for consistency.
  const lengthMs = Math.min(190000, Math.max(3000, Math.round(opts.seconds * 1000)));
  const res = await rawPost(new URL(`${cfg.baseUrl}/v1/music`), {
    headers: {
      "xi-api-key": cfg.apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      prompt: opts.prompt,
      music_length_ms: lengthMs,
      ...(opts.instrumental ? { force_instrumental: true } : {}),
    }),
    proxy: detectProxy(),
    signal,
  });
  if (res.status < 200 || res.status >= 300) {
    const errText = await readAll(res.stream);
    let msg = errText.slice(0, 300);
    try {
      const parsed = JSON.parse(errText) as { detail?: { message?: string } | string };
      msg =
        (typeof parsed.detail === "object" ? parsed.detail?.message : parsed.detail) || msg;
    } catch {
      // Not JSON — keep the raw excerpt.
    }
    throw new Error(`ElevenLabs API 错误 (${res.status}): ${msg}`);
  }
  const audio = await readAllBinary(res.stream);
  if (!audio.length) throw new Error("ElevenLabs 返回了空音频");
  return saveGeneratedAudio(audio, "mp3");
}

// ---------- MiniMax music_generation (sync JSON → hex mp3; status:1 repoll) ----------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("请求已停止"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("请求已停止"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

interface MiniMaxResponse {
  data?: { audio?: string; status?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

async function genMiniMax(
  cfg: AudioGenConfig,
  opts: GenerateOptions,
  signal?: AbortSignal,
): Promise<string> {
  const lyrics = opts.lyrics?.trim() || "";
  const body = JSON.stringify({
    model: "music-3.0",
    prompt: opts.prompt,
    // music-3.0 requires lyrics for vocal songs; a DAW assistant defaults to
    // instrumental (no vocals, lyrics optional) unless lyrics are given.
    ...(lyrics ? { lyrics } : {}),
    instrumental: opts.instrumental ?? !lyrics,
    stream: false,
    output_format: "hex",
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
  });
  // Normally one held request answers with status:2. If the platform answers
  // status:1 (still rendering), re-POST the identical request — the async
  // poll path (≤ ~3 min overall).
  for (let attempt = 0; attempt < 60; attempt++) {
    if (attempt > 0) await sleep(3000, signal);
    const res = await rawPost(new URL(`${cfg.baseUrl}/v1/music_generation`), {
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body,
      proxy: detectProxy(),
      signal,
    });
    const text = await readAll(res.stream);
    let data: MiniMaxResponse;
    try {
      data = JSON.parse(text) as MiniMaxResponse;
    } catch {
      throw new Error(`MiniMax API 错误 (${res.status}): ${text.slice(0, 300)}`);
    }
    const base = data.base_resp;
    if (res.status < 200 || res.status >= 300 || (base?.status_code ?? 0) !== 0) {
      throw new Error(
        `MiniMax API 错误 (${res.status}${base?.status_code ? ` / code ${base.status_code}` : ""}): ${base?.status_msg || text.slice(0, 200)}`,
      );
    }
    if (data.data?.status === 1 || !data.data?.audio) continue; // still rendering
    const audio = Buffer.from(data.data.audio, "hex");
    if (!audio.length) throw new Error("MiniMax 返回了空音频");
    return saveGeneratedAudio(audio, "mp3");
  }
  throw new Error("MiniMax 生成超时(约 3 分钟仍在渲染)");
}

// ---------- Custom HTTP provider (relays / self-hosted / Suno-style) ----------

/** Dot-path walk ("data.audio.url", numeric segments index arrays). */
function jsonPath(obj: unknown, dotPath: string): unknown {
  let cur = obj;
  for (const key of dotPath.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Fill {{prompt}} (JSON-escaped) and {{duration}} (raw number) in a body template. */
function fillTemplate(template: string, prompt: string, seconds: number): string {
  return template
    .replaceAll("{{prompt}}", JSON.stringify(prompt).slice(1, -1))
    .replaceAll("{{duration}}", String(seconds));
}

const MIME_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/aiff": "aif",
  "audio/x-aiff": "aif",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

/** Best-guess file extension: explicit format > content-type > URL suffix > wav. */
function guessExt(explicit: string | undefined, contentType: unknown, url?: string): string {
  if (explicit && /^[a-z0-9]{2,5}$/i.test(explicit)) return explicit.toLowerCase();
  const mime = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  if (url) {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (ext && AUDIO_EXT.has("." + ext)) return ext;
  }
  return "wav";
}

function customHeaders(cfg: AudioGenConfig, t: CustomAudioTemplate): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const style = t.authHeader ?? "bearer";
  if (cfg.apiKey && style === "bearer") headers.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.apiKey && style === "x-api-key") headers["x-api-key"] = cfg.apiKey;
  return headers;
}

async function genCustom(
  cfg: AudioGenConfig,
  opts: GenerateOptions,
  signal?: AbortSignal,
): Promise<string> {
  const t = cfg.custom ?? {};
  if (!cfg.baseUrl) {
    throw new Error("自定义 provider 未填接口地址:设置(齿轮)→ 音频生成 → Custom,填 Request URL");
  }
  const body = t.bodyTemplate?.trim()
    ? fillTemplate(t.bodyTemplate, opts.prompt, opts.seconds)
    : JSON.stringify({ prompt: opts.prompt, duration: opts.seconds });
  const res = await rawPost(new URL(cfg.baseUrl), {
    headers: customHeaders(cfg, t),
    body,
    proxy: detectProxy(),
    signal,
  });

  // Async task mode: submit answered a task id → poll until done → download.
  if (t.pollUrl && t.pollTaskId) {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`自定义 API 提交失败 (${res.status}): ${(await readAll(res.stream)).slice(0, 300)}`);
    }
    const submitText = await readAll(res.stream);
    let submitJson: unknown;
    try {
      submitJson = JSON.parse(submitText);
    } catch {
      throw new Error(`自定义 API 提交响应不是 JSON: ${submitText.slice(0, 200)}`);
    }
    const taskId = jsonPath(submitJson, t.pollTaskId);
    if (taskId == null || taskId === "") {
      throw new Error(`提交响应里找不到任务 ID(路径 ${t.pollTaskId}): ${submitText.slice(0, 200)}`);
    }
    return pollCustom(cfg, t, String(taskId), signal);
  }

  return customFromResponse(res, t, res.status, cfg.baseUrl);
}

/** Interpret a sync custom response per responseType and save the audio. */
async function customFromResponse(
  res: { status: number; headers: Record<string, unknown>; stream: AsyncIterable<Buffer> },
  t: CustomAudioTemplate,
  status: number,
  sourceUrl: string,
): Promise<string> {
  const type = t.responseType ?? "bytes";
  if (status < 200 || status >= 300) {
    throw new Error(`自定义 API 错误 (${status}): ${(await readAll(res.stream)).slice(0, 300)}`);
  }
  if (type === "bytes") {
    const audio = await readAllBinary(res.stream);
    if (!audio.length) throw new Error("自定义 API 返回了空音频");
    return saveGeneratedAudio(audio, guessExt(t.format, res.headers["content-type"]));
  }
  const text = await readAll(res.stream);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`自定义 API 响应不是 JSON(responseType=${type}): ${text.slice(0, 200)}`);
  }
  const value = t.audioPath ? jsonPath(json, t.audioPath) : undefined;
  if (typeof value !== "string" || !value) {
    throw new Error(`响应里找不到音频字段(路径 ${t.audioPath ?? "(未填)"}): ${text.slice(0, 200)}`);
  }
  if (type === "url") return downloadCustom(value, t, undefined);
  const audio = Buffer.from(value, type === "hex" ? "hex" : "base64");
  if (!audio.length) throw new Error(`自定义 API 的 ${type} 字段解码后为空`);
  return saveGeneratedAudio(audio, guessExt(t.format, undefined, sourceUrl));
}

/** Download an audio URL produced by a custom API (sync url type or async poll). */
async function downloadCustom(
  url: string,
  t: CustomAudioTemplate,
  signal?: AbortSignal,
): Promise<string> {
  const res = await rawGet(new URL(url), {
    headers: {},
    proxy: detectProxy(),
    signal,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`音频下载失败 (${res.status}): ${url.slice(0, 120)}`);
  }
  const audio = await readAllBinary(res.stream);
  if (!audio.length) throw new Error("下载到的音频为空");
  return saveGeneratedAudio(audio, guessExt(t.format, res.headers["content-type"], url));
}

/** Poll an async custom task until pollStatusPath == pollDoneValue (~4 min cap). */
async function pollCustom(
  cfg: AudioGenConfig,
  t: CustomAudioTemplate,
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const statusPath = t.pollStatusPath || "status";
  const doneValue = t.pollDoneValue || "succeeded";
  for (let attempt = 0; attempt < 80; attempt++) {
    await sleep(3000, signal);
    const url = t.pollUrl!.replaceAll("{taskId}", encodeURIComponent(taskId));
    const res = await rawGet(new URL(url), {
      headers: customHeaders(cfg, t),
      proxy: detectProxy(),
      signal,
    });
    const text = await readAll(res.stream);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`轮询响应不是 JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    const status = jsonPath(json, statusPath);
    if (String(status) === doneValue) {
      const audioUrl = t.pollAudioPath ? jsonPath(json, t.pollAudioPath) : undefined;
      if (typeof audioUrl !== "string" || !audioUrl) {
        throw new Error(`任务完成但找不到音频地址(路径 ${t.pollAudioPath ?? "(未填)"})`);
      }
      return downloadCustom(audioUrl, t, signal);
    }
    if (status == null) {
      throw new Error(`轮询响应里找不到状态字段(路径 ${statusPath}): ${text.slice(0, 200)}`);
    }
    const s = String(status).toLowerCase();
    if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled") {
      throw new Error(`自定义 API 任务失败: ${text.slice(0, 200)}`);
    }
  }
  throw new Error("自定义 API 生成超时(约 4 分钟仍未完成)");
}

// ---------- Save into the User Library ----------

/**
 * Where generated files land: <User Library>/AIbleton — visible in Live's
 * browser under the User Library and indexed by search_samples (the handler
 * drops the index cache after each generation).
 */
export function generatedAudioDir(): string {
  const lib = resolveAbletonLibraryPaths();
  const userLib =
    lib.userLibraries[0] ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "Documents", "Ableton", "User Library")
      : path.join(os.homedir(), "Music", "Ableton", "User Library"));
  return path.join(userLib, "AIbleton");
}

function saveGeneratedAudio(audio: Buffer, ext: string): string {
  const dir = generatedAudioDir();
  mkdirOutsideSandbox(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const file = path.join(dir, `gen-${stamp}-${rand}.${ext}`);
  writeHomeBinary(file, audio);
  return file;
}
