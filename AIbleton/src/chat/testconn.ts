/**
 * Settings-page "Test connection" probe.
 *
 * Answers the one question the settings UI can't: did the configuration
 * actually work? Each provider gets the lightest call that still proves
 * something real — a models-list GET where the API has one (no tokens
 * spent), a 1-token generation probe only when the user explicitly clicks
 * "Test connection" AND the endpoint has no models list to check against
 * (some relays). Mirrors each provider's chat transport: plain fetch for
 * Anthropic (like chatAnthropic), proxy-aware rawRequest for the rest.
 *
 * Status vocabulary consumed by ui/interface.html:
 *   connected         — endpoint reachable, auth accepted
 *   not_configured    — no credentials/baseUrl yet (no network call made)
 *   auth_expired      — 401/403 (or an un-refreshable ChatGPT login)
 *   model_unavailable — auth OK, but the resolved model isn't offered
 *   unreachable       — DNS/TLS/proxy/timeout failure
 *   error             — anything else (detail carries the short reason)
 */

import { URL } from "node:url";
import { detectProxy, rawGet, rawPost, readAll } from "../http.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { ensureCodexAuth } from "./providers/openai.js";
import { errMessage } from "../errors.js";
import type { Provider } from "../config/local.js";

export type ConnStatus =
  | "connected"
  | "not_configured"
  | "auth_expired"
  | "model_unavailable"
  | "unreachable"
  | "error";

export interface ConnTestResult {
  status: ConnStatus;
  /** Resolved model the probe checked (when there is one). */
  model?: string;
  /** Short unlocalized reason for the tooltip ("rate limited", "timeout"…). */
  detail?: string;
}

// The sandbox lacks AbortSignal.timeout — hand-rolled controller + timer.
function timedSignal(ms = 12000): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

const ok = (model?: string, detail?: string): ConnTestResult => ({
  status: "connected",
  ...(model ? { model } : {}),
  ...(detail ? { detail } : {}),
});

const fail = (status: ConnStatus, model?: string, detail?: string): ConnTestResult => ({
  status,
  ...(model ? { model } : {}),
  ...(detail ? { detail } : {}),
});

/** rawRequest aborts with the stop message — here that can only be our timer. */
function netFail(err: unknown, model?: string): ConnTestResult {
  const msg = errMessage(err);
  return fail("unreachable", model, msg === "请求已停止" ? "timeout" : msg.slice(0, 120));
}

/** 401/403 mean the key itself was rejected; everything else keeps flowing. */
export function classifyAuth(status: number): ConnStatus | null {
  return status === 401 || status === 403 ? "auth_expired" : null;
}

/** Model-availability errors phrased by the various APIs. */
const MODEL_ERR_RE =
  /model[_ "'s]{0,30}(not.?found|does not exist|unsupported|unrecognized|invalid|unknown|is not supported)|no such model|invalid model|model_not_found/i;

/** Model ids from a GET-models body: OpenAI/Anthropic {data:[{id}]} or Gemini {models:[{name}]}. */
export function parseModelIds(body: string): string[] {
  try {
    const j = JSON.parse(body) as {
      data?: { id?: string }[];
      models?: { name?: string }[];
    };
    if (Array.isArray(j.data)) return j.data.map((m) => m?.id).filter((x): x is string => Boolean(x));
    if (Array.isArray(j.models))
      return j.models.map((m) => m?.name).filter((x): x is string => Boolean(x));
  } catch {
    // Unparseable — treated as "no list to check against".
  }
  return [];
}

/**
 * Is the configured model covered by the listed ids? Exact match or the
 * listed id extending the configured name (undated alias → dated variant:
 * "claude-sonnet-5" covers "claude-sonnet-5-20260101"). Gemini ids carry a
 * "models/" prefix.
 */
export function modelInList(ids: string[], model: string): boolean {
  return ids.some((id) => {
    const b = id.startsWith("models/") ? id.slice(7) : id; // Gemini prefix
    if (b === model) return true;
    // Undated alias → dated/versioned variant ("…-20260101", "…-001"), but
    // never a different model ("gpt-5-codex" ≠ "gpt-5-codex-mini").
    if (!b.startsWith(`${model}-`)) return false;
    return /^\d[\d-]*$/.test(b.slice(model.length + 1));
  });
}

/**
 * Shared tail for a successful models-list response.
 *
 * Membership is only AUTHORITATIVE on the official endpoint: a third-party
 * Anthropic/OpenAI relay often lists its upstream's models while actually
 * ignoring or rewriting the model field per request — there a missing name
 * must not read as "model unavailable" when chat would work fine. On relays
 * it degrades to an advisory detail on an otherwise-green result.
 */
export function fromModelList(
  body: string,
  model: string | undefined,
  authoritative: boolean,
): ConnTestResult {
  const ids = parseModelIds(body);
  if (ids.length && model && !modelInList(ids, model)) {
    return authoritative
      ? fail("model_unavailable", model, "not in the endpoint's model list")
      : ok(model, `"${model}" not in the list — relays often map models anyway`);
  }
  return ok(model);
}

/** Is this baseUrl the provider's official API (where the model list is truth)? */
function isOfficialHost(baseUrl: string, official: string): boolean {
  try {
    return new URL(baseUrl).hostname === official;
  } catch {
    return false;
  }
}

/** Map a minimal-generation probe's response (1-token chat call). */
function classifyGeneration(status: number, body: string, model?: string): ConnTestResult {
  const auth = classifyAuth(status);
  if (auth) return fail(auth, model);
  if (status === 429) return ok(model, "rate limited (auth OK)");
  if (status >= 200 && status < 300) return ok(model);
  if (MODEL_ERR_RE.test(body) || (status === 404 && /model/i.test(body))) {
    return fail("model_unavailable", model, `HTTP ${status}`);
  }
  const short = body.replace(/\s+/g, " ").slice(0, 120);
  return fail("error", model, `HTTP ${status}${short ? `: ${short}` : ""}`);
}

async function getJson(
  target: URL,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { signal, done } = timedSignal();
  try {
    const res = await rawGet(target, { headers, proxy: detectProxy(), signal });
    return { status: res.status, body: await readAll(res.stream) };
  } finally {
    done();
  }
}

async function postJson(
  target: URL,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const { signal, done } = timedSignal();
  try {
    const res = await rawPost(target, {
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      proxy: detectProxy(),
      signal,
    });
    return { status: res.status, body: await readAll(res.stream) };
  } finally {
    done();
  }
}

/** Anthropic chat rides plain fetch (no proxy tunnel) — the probe must too. */
async function fetchJson(
  method: "GET" | "POST",
  target: string,
  headers: Record<string, string>,
  payload?: unknown,
): Promise<{ status: number; body: string }> {
  const { signal, done } = timedSignal();
  try {
    const res = await fetch(target, {
      method,
      headers: payload
        ? { "content-type": "application/json", ...headers }
        : headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    done();
  }
}

// ---------- Per-provider probes ----------

/** 1-token /v1/messages probe: proves auth + model in one call. */
async function probeClaudeMessage(cfg: ResolvedConfig): Promise<ConnTestResult> {
  let r: { status: number; body: string };
  try {
    r = await fetchJson(
      "POST",
      `${cfg.baseUrl}/v1/messages`,
      {
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${cfg.authToken}`,
        "x-api-key": cfg.authToken,
      },
      { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    );
  } catch (err) {
    return netFail(err, cfg.model);
  }
  return classifyGeneration(r.status, r.body, cfg.model);
}

async function testClaude(full: boolean): Promise<ConnTestResult> {
  const cfg = resolveConfig({ provider: "claude" });
  if (!cfg.authToken) return fail("not_configured", cfg.model);
  let r: { status: number; body: string };
  try {
    r = await fetchJson("GET", `${cfg.baseUrl}/v1/models`, {
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${cfg.authToken}`,
      "x-api-key": cfg.authToken,
    });
  } catch (err) {
    return netFail(err, cfg.model);
  }
  const auth = classifyAuth(r.status);
  if (auth) return fail(auth, cfg.model);
  if (r.status === 429) return ok(cfg.model, "rate limited (auth OK)");
  if (r.status >= 200 && r.status < 300) {
    return fromModelList(r.body, cfg.model, isOfficialHost(cfg.baseUrl, "api.anthropic.com"));
  }
  // No models list on this endpoint (some relays): a quick test can only say
  // "not refused"; the explicit button spends the 1-token probe to know for sure.
  if (!full) return ok(cfg.model, `no model list (HTTP ${r.status}) — run Test connection`);
  return probeClaudeMessage(cfg);
}

async function testCodex(): Promise<ConnTestResult> {
  const cfg = resolveConfig({ provider: "codex" });
  if (!cfg.authToken && !cfg.refreshToken) return fail("not_configured", cfg.model);
  if (cfg.chatgpt) {
    // ChatGPT-account mode: the cheap meaningful check is the token itself —
    // refresh it if due. The codex backend has no keyless models list, and a
    // real probe would be an SSE generation, so a fresh token = connected.
    try {
      await ensureCodexAuth(cfg);
    } catch {
      return fail("auth_expired", cfg.model, "ChatGPT login expired — run `codex login`");
    }
    return ok(cfg.model, "ChatGPT account");
  }
  let r: { status: number; body: string };
  try {
    r = await getJson(new URL(`${cfg.baseUrl}/models`), {
      authorization: `Bearer ${cfg.authToken}`,
    });
  } catch (err) {
    return netFail(err, cfg.model);
  }
  const auth = classifyAuth(r.status);
  if (auth) return fail(auth, cfg.model);
  if (r.status === 429) return ok(cfg.model, "rate limited (auth OK)");
  if (r.status >= 200 && r.status < 300) {
    return fromModelList(r.body, cfg.model, isOfficialHost(cfg.baseUrl, "api.openai.com"));
  }
  // /models unsupported: auth wasn't refused — the /responses probe would
  // cost a generation, so leave it at "reachable".
  return ok(cfg.model, `no model list (HTTP ${r.status})`);
}

async function testGemini(): Promise<ConnTestResult> {
  const cfg = resolveConfig({ provider: "gemini" });
  if (!cfg.authToken) return fail("not_configured", cfg.model);
  let r: { status: number; body: string };
  try {
    r = await getJson(new URL(`${cfg.baseUrl}/v1beta/models`), {
      "x-goog-api-key": cfg.authToken,
    });
  } catch (err) {
    return netFail(err, cfg.model);
  }
  // Gemini reports an invalid key as 400 API_KEY_INVALID, not 401.
  if (classifyAuth(r.status) || (r.status === 400 && /api[-_ ]?key/i.test(r.body))) {
    return fail("auth_expired", cfg.model, `HTTP ${r.status}`);
  }
  if (r.status === 429) return ok(cfg.model, "rate limited (auth OK)");
  if (r.status >= 200 && r.status < 300) {
    return fromModelList(
      r.body,
      cfg.model,
      isOfficialHost(cfg.baseUrl, "generativelanguage.googleapis.com"),
    );
  }
  return fail("error", cfg.model, `HTTP ${r.status}`);
}

/** 1-token chat/completions probe for endpoints without a models list. */
async function probeCustomChat(cfg: ResolvedConfig): Promise<ConnTestResult> {
  let r: { status: number; body: string };
  try {
    r = await postJson(
      new URL(`${cfg.baseUrl}/chat/completions`),
      cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : {},
      { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    );
  } catch (err) {
    return netFail(err, cfg.model);
  }
  return classifyGeneration(r.status, r.body, cfg.model);
}

async function testCustom(full: boolean): Promise<ConnTestResult> {
  const cfg = resolveConfig({ provider: "custom" });
  // Keyless local servers (Ollama…) are valid — "configured" = baseUrl + model.
  if (!cfg.baseUrl || !cfg.model) return fail("not_configured");
  const headers: Record<string, string> = cfg.authToken
    ? { authorization: `Bearer ${cfg.authToken}` }
    : {};
  let r: { status: number; body: string };
  try {
    r = await getJson(new URL(`${cfg.baseUrl}/models`), headers);
  } catch (err) {
    return netFail(err, cfg.model);
  }
  const auth = classifyAuth(r.status);
  if (auth) return fail(auth, cfg.model);
  if (r.status === 429) return ok(cfg.model, "rate limited (auth OK)");
  // Custom = the user typed both baseUrl and model; a model missing from the
  // endpoint's own list is almost always a typo, so the check stays strict.
  if (r.status >= 200 && r.status < 300) return fromModelList(r.body, cfg.model, true);
  if (!full) return ok(cfg.model, `no model list (HTTP ${r.status}) — run Test connection`);
  return probeCustomChat(cfg);
}

export function testConnection(provider: Provider, full: boolean): Promise<ConnTestResult> {
  if (provider === "codex") return testCodex();
  if (provider === "gemini") return testGemini();
  if (provider === "custom") return testCustom(full);
  return testClaude(full);
}
