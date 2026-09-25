/**
 * User-actionable error mapping.
 *
 * Raw API / provider / Node errors ("fetch failed", "401 model_not_found …")
 * tell the user nothing they can act on. This module rewrites them at the
 * boundary where they surface — chat providers (shown in the UI via
 * lastError), audio generation (relayed by the model), and the tool
 * dispatcher — into "what happened + what to do about it".
 *
 * Pure string matching, no I/O: safe inside the Extension Host sandbox.
 */

import { apiErrorText } from "./i18n/errors.js";
import { commonText } from "./i18n/common.js";
import { normalizeLanguage, resolveReplyLanguage } from "./i18n/language.js";

/** Marker so a mapped error never gets re-wrapped by an outer catch. */
const FRIENDLY_MARK = "__aibletonFriendly";

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isFriendlyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)[FRIENDLY_MARK] === true
  );
}

/**
 * A hand-written actionable message, pre-marked so outer friendlyApiError
 * catches pass it through instead of re-wrapping it.
 */
export function actionableError(message: string): Error {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>)[FRIENDLY_MARK] = true;
  return err;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly params: Record<string, string | number | string[]> = {},
  ) {
    super(code);
    this.name = "AppError";
  }
}

/** Settings-menu path matching the UI labels (gear menu), per UI language. */
export function settingsPath(language: string | undefined, section: "ai" | "audio"): string {
  return commonText(language, section === "ai" ? "settingsAi" : "settingsAudio");
}

export interface FriendlyApiErrorOpts {
  /** Service label: "Claude", "Codex", "Gemini", "Stable Audio", … */
  what: string;
  /** Where the user fixes it — settingsPath(language, …). */
  settings: string;
  status?: number;
  raw?: string;
  model?: string;
  language?: string;
}

const NETWORK_RE =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|getaddrinfo|NetworkError|timed?\s?out|超时|代理/i;
const RESPONSE_TIMEOUT_RE = /UND_ERR_(?:HEADERS|BODY)_TIMEOUT|HeadersTimeoutError|BodyTimeoutError/i;
const QUOTA_RE =
  /insufficient[_ ]quota|exceeded your current quota|credit balance|billing|not enough.{0,20}(quota|credit|balance)|余额不足|欠费/i;
const RATE_RE = /too frequent|rate.?limit|too many requests|requests per (min|hour|day)|限流/i;
const AUTH_RE =
  /unauthorized|forbidden|invalid (api[- ]?key|x-api-key|token)|incorrect api key|authentication|expired.{0,15}token|permission denied|invalid_api_key/i;
const MODEL_RE =
  /model[_ "'s]{0,30}(not.?found|does not exist|unsupported|unrecognized|invalid|unknown|is not supported)|no such model|invalid model|model_not_found/i;
const OVERLOADED_RE =
  /overloaded|capacity|service unavailable|bad gateway|internal server error|temporarily unavailable/i;

/**
 * Map a raw provider/HTTP failure to an actionable message. Never throws;
 * the stop signal ("请求已停止") and already-mapped errors pass through
 * untouched so /api/stop keeps working and catches never double-wrap.
 */
export function friendlyApiError(opts: FriendlyApiErrorOpts): Error {
  const { what, settings, status, model } = opts;
  const raw = (opts.raw ?? "").trim();
  // Internal control-flow sentinel; providers convert it to a localized stop
  // note before anything is shown to the user.
  if (raw === "请求已停止") return new Error(raw);
  const rawShort = raw.length > 160 ? raw.slice(0, 160) + "…" : raw;
  const where = status ? ` (${status})` : "";

  let msg: string;
  if (raw && RESPONSE_TIMEOUT_RE.test(raw) && !status) {
    msg = apiErrorText(opts.language, "timeout", what);
  } else if (raw && NETWORK_RE.test(raw) && !status) {
    msg = /代理/.test(raw)
      ? apiErrorText(opts.language, "networkProxy", what, rawShort)
      : apiErrorText(opts.language, "network", what);
  } else if (QUOTA_RE.test(raw)) {
    msg = apiErrorText(opts.language, "quota", what, settings);
  } else if (status === 429 || RATE_RE.test(raw)) {
    msg = apiErrorText(opts.language, "rate", what);
  } else if (status === 401 || status === 403 || AUTH_RE.test(raw)) {
    msg = apiErrorText(opts.language, "auth", what, settings);
  } else if (MODEL_RE.test(raw) || (status === 404 && /model/i.test(raw))) {
    msg = apiErrorText(opts.language, "model", what, model ? ` "${model}"` : "", settings);
  } else if (
    status === 500 || status === 502 || status === 503 || status === 529 || OVERLOADED_RE.test(raw)
  ) {
    msg = apiErrorText(opts.language, "overloaded", what, where);
  } else {
    const lang = normalizeLanguage(opts.language);
    const rawForUser = lang === "zh"
      ? (rawShort || "未知错误")
      : lang === "en"
        ? (rawShort && !/[\u3400-\u9fff]/u.test(rawShort) ? rawShort : "unknown error")
        : "PROVIDER_ERROR";
    msg = apiErrorText(opts.language, "generic", what, where, rawForUser, settings);
  }
  const err = new Error(msg);
  (err as unknown as Record<string, unknown>)[FRIENDLY_MARK] = true;
  return err;
}

/** Same idea for audio generation — the fix lives in Settings → Audio Generation. */
export function friendlyAudioError(
  what: string,
  status: number | undefined,
  raw: string,
  language?: string,
): Error {
  return friendlyApiError({
    what,
    settings: settingsPath(language, "audio"),
    ...(status !== undefined ? { status } : {}),
    raw,
    language,
  });
}

/** Live-side object went away (track/clip deleted or the Set rebuilt). */
const LIVE_GONE_RE =
  /invalid object reference|object of incorrect type|unknown object type|not exist anymore|no longer exists|stale handle/i;

/**
 * Model-facing rewrite of raw tool-execution failures (rides the tool result,
 * bilingual like the other dispatcher messages). Unknown errors pass through
 * with their original message.
 */
export function friendlyToolError(err: unknown, language?: string): string {
  const msg = errMessage(err);
  const lang = normalizeLanguage(language);
  const containsHan = /[\u3400-\u9fff]/u.test(msg);
  if (isFriendlyError(err)) {
    const detected = resolveReplyLanguage({ text: msg, panelLanguage: lang });
    const localized = detected.source !== "message" || detected.language === lang;
    return localized ? msg : commonText(language, "toolFailed", "TOOL_EXECUTION");
  }
  if (err instanceof AppError) {
    return commonText(language, "toolFailed", err.code);
  }
  if (LIVE_GONE_RE.test(msg)) {
    return commonText(language, "liveObjectGone");
  }
  const safeRaw = (lang === "zh" && containsHan) || (lang === "en" && !containsHan);
  return safeRaw ? msg : commonText(language, "toolFailed", "TOOL_EXECUTION");
}

const TOOL_PROSE_KEYS = new Set(["error", "warning", "undo", "index_refreshed"]);

function proseMatchesLanguage(text: string, language: string | undefined): boolean {
  const lang = normalizeLanguage(language);
  const detected = resolveReplyLanguage({ text, panelLanguage: lang });
  return detected.source !== "message" || detected.language === lang;
}

function replacementForToolProse(key: string, language?: string): string {
  if (key === "error") return commonText(language, "toolFailed", "LEGACY_TOOL_RESULT");
  if (key === "warning" || key === "warnings") return commonText(language, "genericWarning");
  if (key === "undo") return commonText(language, "undoInLive");
  if (key === "index_refreshed") return commonText(language, "targetRefreshed");
  return commonText(language, "operationCompleted");
}

/**
 * Transitional guard for legacy tool results that still contain prose.
 * Structured values and user-authored names are untouched; only known prose
 * fields are replaced when their detected language conflicts with the turn.
 */
export function sanitizeToolResultLanguage(result: unknown, language?: string, key = ""): unknown {
  if (typeof result === "string") {
    return TOOL_PROSE_KEYS.has(key) && !proseMatchesLanguage(result, language)
      ? replacementForToolProse(key, language)
      : result;
  }
  if (Array.isArray(result)) {
    return result.map((value) => sanitizeToolResultLanguage(value, language, key === "warnings" ? "warning" : key));
  }
  if (!result || typeof result !== "object") return result;
  return Object.fromEntries(
    Object.entries(result as Record<string, unknown>).map(([childKey, value]) => [
      childKey,
      sanitizeToolResultLanguage(value, language, childKey),
    ]),
  );
}

/** Final UI boundary for background-task failures (`lastError`). */
export function friendlyBoundaryError(err: unknown, language?: string, code = "CHAT_TASK"): string {
  const msg = errMessage(err);
  const lang = normalizeLanguage(language);
  const detected = resolveReplyLanguage({ text: msg, panelLanguage: lang });
  if (detected.source !== "message" || detected.language === lang) return msg;
  return commonText(language, "genericError", code);
}
