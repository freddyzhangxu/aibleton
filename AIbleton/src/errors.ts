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

/** Settings-menu path matching the UI labels (gear menu), per UI language. */
export function settingsPath(language: string | undefined, section: "ai" | "audio"): string {
  const zh = (language ?? "").startsWith("zh");
  return zh
    ? `设置（齿轮）→ ${section === "ai" ? "AI 配置" : "音频生成"}`
    : `Settings (gear icon) → ${section === "ai" ? "AI Provider" : "Audio Generation"}`;
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
  if (raw === "请求已停止") return new Error(raw);
  const zh = (opts.language ?? "").startsWith("zh");
  const pick = (z: string, e: string) => (zh ? z : e);
  const rawShort = raw.length > 160 ? raw.slice(0, 160) + "…" : raw;
  const where = status ? ` (${status})` : "";

  let msg: string;
  if (raw && NETWORK_RE.test(raw) && !status) {
    msg = /代理/.test(raw)
      ? pick(
          `连不上 ${what}：代理连接失败（${rawShort}）— 确认代理已启动且端口正确，或检查网络后重试。`,
          `Couldn't reach ${what}: proxy connection failed (${rawShort}) — check that the proxy is running on the right port, then try again.`,
        )
      : pick(
          `连不上 ${what} — 检查网络连接（海外服务可能需要代理）后重试。`,
          `Couldn't reach ${what} — check your network connection (an overseas service may need a proxy) and try again.`,
        );
  } else if (QUOTA_RE.test(raw)) {
    msg = pick(
      `${what} 账户额度不足 — 到 ${what} 控制台充值/升级，或在 ${settings} 更换 API Key。`,
      `Your ${what} account is out of quota — top up in the ${what} console, or set a different API key in ${settings}.`,
    );
  } else if (status === 429 || RATE_RE.test(raw)) {
    msg = pick(
      `请求太频繁，${what} 暂时限流。等 1 分钟再试；持续出现请到 ${what} 控制台检查账户用量额度。`,
      `${what} is rate-limiting requests. Wait a minute and retry; if it persists, check your ${what} account usage.`,
    );
  } else if (status === 401 || status === 403 || AUTH_RE.test(raw)) {
    msg = pick(
      `${what} 拒绝了请求：API Key 无效或已过期。打开 ${settings} 重新填写后再试。`,
      `${what} rejected the request: the API key is invalid or expired. Open ${settings} to update it, then try again.`,
    );
  } else if (MODEL_RE.test(raw) || (status === 404 && /model/i.test(raw))) {
    msg = pick(
      `模型名称${model ? `「${model}」` : ""}无效 — ${what} 不认识这个模型。打开 ${settings} 检查模型名拼写。`,
      `${what} doesn't recognize the model${model ? ` "${model}"` : ""}. Open ${settings} and check the model name.`,
    );
  } else if (
    status === 500 || status === 502 || status === 503 || status === 529 || OVERLOADED_RE.test(raw)
  ) {
    msg = pick(
      `${what} 服务暂时繁忙${where} — 稍后重试即可，不用改设置。`,
      `${what} is temporarily overloaded${where} — try again in a moment; no settings change needed.`,
    );
  } else {
    msg = pick(
      `${what} 出错${where}：${rawShort || "未知错误"} — 若反复出现，请检查 ${settings} 的配置。`,
      `${what} failed${where}: ${rawShort || "unknown error"} — if this keeps happening, check ${settings}.`,
    );
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
export function friendlyToolError(err: unknown): string {
  const msg = errMessage(err);
  if (LIVE_GONE_RE.test(msg)) {
    return (
      `操作对象已在 Live 中被删除或失效（原错误: ${msg}）— 先调用 get_song_overview 获取最新轨道/clip 状态，再重新指定目标。` +
      ` / The target was deleted in Live — call get_song_overview for the current state, then retry.`
    );
  }
  return msg;
}
