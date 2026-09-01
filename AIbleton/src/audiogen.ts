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
  mkdirOutsideSandbox,
  resolveAbletonLibraryPaths,
  writeHomeBinary,
} from "./paths.js";
import { detectProxy, rawPost, readAll, readAllBinary } from "./http.js";

export type AudioProvider = "stable-audio" | "elevenlabs" | "minimax";

export const AUDIO_PROVIDER_NAMES: Record<AudioProvider, string> = {
  "stable-audio": "Stable Audio",
  elevenlabs: "ElevenLabs",
  minimax: "MiniMax",
};

const AUDIO_PROVIDER_DEFAULTS: Record<AudioProvider, { base: string; env: string }> = {
  "stable-audio": { base: "https://api.stability.ai", env: "STABILITY_API_KEY" },
  elevenlabs: { base: "https://api.elevenlabs.io", env: "ELEVENLABS_API_KEY" },
  minimax: { base: "https://api.minimaxi.com", env: "MINIMAX_API_KEY" },
};

export interface AudioGenConfig {
  provider: AudioProvider;
  apiKey: string;
  baseUrl: string;
}

export interface AudioRequestConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

export function resolveAudioConfig(audio?: AudioRequestConfig): AudioGenConfig | null {
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
  return AUDIO_PROVIDER_DEFAULTS[provider].env;
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

// ---------- Save into the User Library ----------

/**
 * Where generated files land: <User Library>/AIbleton — visible in Live's
 * browser under the User Library and indexed by search_samples (the handler
 * drops the index cache after each generation).
 */
function generatedAudioDir(): string {
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
