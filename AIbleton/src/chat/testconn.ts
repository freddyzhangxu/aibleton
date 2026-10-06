/**
 * Settings-page "Test connection" probe.
 *
 * Answers the one question the settings UI can't: did the configuration
 * actually work? Each provider gets the lightest call that still proves
 * something real — a models-list GET where the API has one (no tokens
 * spent), a 1-token generation probe only when the user explicitly clicks
 * "Test connection" AND the endpoint has no models list to check against
 * (some relays). A clean explicit probe is remembered by the server
 * (providers.json "verified"), so the quick check stops nudging once a
 * relay model is proven. Mirrors each provider's chat transport: plain
 * fetch for Anthropic (like chatAnthropic), proxy-aware rawRequest for the rest.
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
import { parseCustomResponse } from "./providers/custom-response.js";
import { errMessage } from "../errors.js";
import { loadLocalModelIds, type Provider } from "../config/local.js";
import type { AudioGenConfig } from "../audiogen.js";

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

/**
 * Quick-check answer for a relay model the catalog didn't confirm: once an
 * explicit full test has proven generation on this endpoint (persisted by
 * the server), reopening the settings stays a clean "Connected".
 */
function advisory(model: string, verified: string[] | undefined, detail: string): ConnTestResult {
  return verified?.includes(model) ? ok(model) : ok(model, detail);
}

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

async function testClaude(full: boolean, verified?: string[]): Promise<ConnTestResult> {
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
    // Membership is authoritative only on the official endpoint. A relay
    // catalog (ark etc.) can omit an alias it still maps per request — there
    // the explicit test spends the 1-token probe to know for sure, and the
    // quick check stays an advisory.
    if (isOfficialHost(cfg.baseUrl, "api.anthropic.com")) {
      return fromModelList(r.body, cfg.model, true);
    }
    const ids = parseModelIds(r.body);
    if (ids.length && !modelInList(ids, cfg.model)) {
      if (!full) return advisory(cfg.model, verified, `"${cfg.model}" not in the list — run Test connection`);
      return probeClaudeMessage(cfg);
    }
    return ok(cfg.model);
  }
  // No models list on this endpoint (some relays): a quick test can only say
  // "not refused"; the explicit button spends the 1-token probe to know for sure.
  if (!full) return advisory(cfg.model, verified, `no model list (HTTP ${r.status}) — run Test connection`);
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
  const result = classifyGeneration(r.status, r.body, cfg.model);
  if (r.status >= 200 && r.status < 300) {
    const data = parseCustomResponse(r.status, r.body);
    if (data.error) return fail("error", cfg.model, data.error.message);
  }
  return result;
}

async function testCustom(full: boolean, verified?: string[]): Promise<ConnTestResult> {
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
  // Relays can expose an upstream catalog that omits valid aliases (including
  // Coding Plan models). Only a generation probe proves whether they work.
  if (r.status >= 200 && r.status < 300) {
    const ids = parseModelIds(r.body);
    if (ids.length && modelInList(ids, cfg.model)) return ok(cfg.model);
    if (!full) {
      return advisory(cfg.model, verified, ids.length
        ? "model not in the list — run Test connection"
        : "no model list — run Test connection");
    }
    return probeCustomChat(cfg);
  }
  if (!full) return advisory(cfg.model, verified, `no model list (HTTP ${r.status}) — run Test connection`);
  return probeCustomChat(cfg);
}

export function testConnection(provider: Provider, full: boolean, verified?: string[]): Promise<ConnTestResult> {
  if (provider === "codex") return testCodex();
  if (provider === "gemini") return testGemini();
  if (provider === "custom") return testCustom(full, verified);
  return testClaude(full, verified);
}

// ---------- Toolbar model picker ----------

export interface ModelListResult {
  /** Catalog ids, empty when the endpoint exposes none (or auth is missing). */
  models: string[];
  /** Short unlocalized reason when the list couldn't be fetched. */
  detail?: string;
  /** Candidates for the compact view; full catalog remains in models. */
  suggestedModels?: string[];
  /** Models from the local CLI configuration, ordered ahead of API models. */
  localModels?: string[];
  previewModels?: string[];
  partial?: boolean;
}

/**
 * Catalog ids as the picker should show them. Gemini ids lose their "models/"
 * prefix and keep only text-generation models — the catalog also lists
 * embedding/aqa entries and tuned models, none of which accept generateContent.
 */
export function pickerModelIds(provider: Provider, body: string): string[] {
  return pickerCatalog(provider, body).models;
}

/** Conservative suggestions, not a claim that generation/tools were tested. */
export function pickerCatalog(provider: Provider, body: string): Required<Pick<ModelListResult, "models" | "suggestedModels" | "previewModels">> {
  const empty = { models: [], suggestedModels: [], previewModels: [] };
  try {
    const json = JSON.parse(body);
    const records: unknown[] = provider === "gemini" ? json?.models : json?.data;
    if (!Array.isArray(records)) return empty;
    const entries = new Map<string, { suggested: boolean; preview: boolean; tools: boolean; created: number; context: number }>();
    // Match dedicated output/task names, not vision-capable chat models.
    const specialty = /(?:^|[\/_-])(?:embedding(?:s)?|embed|rerank(?:er)?|tts|transcrib(?:e|er)|transcription|whisper|image|imagen|video|veo|live|realtime|audio|seedream|seedance|flux|dall-e|stable-diffusion|sdxl)(?:$|[\/_-])/i;
    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as {
        name?: unknown; id?: unknown; supportedGenerationMethods?: unknown;
        architecture?: { output_modalities?: unknown }; supported_parameters?: unknown;
        domain?: unknown; status?: unknown; task_type?: unknown; created?: unknown;
        modalities?: { output_modalities?: unknown };
        features?: { tools?: { function_calling?: unknown } };
        token_limits?: { context_window?: unknown };
      };
      const value = provider === "gemini" ? record.name : record.id;
      if (typeof value !== "string" || !value.trim()) continue;
      const id = provider === "gemini" ? value.trim().replace(/^models\//, "") : value.trim();
      if (provider === "gemini" && !id.startsWith("gemini-")) continue;
      if (entries.has(id)) continue;
      let suggested = true;
      if (provider === "gemini" || provider === "custom" || provider === "claude") {
        suggested = !specialty.test(id);
        const taskType = Array.isArray(record.task_type) ? record.task_type : [];
        const domain = typeof record.domain === "string" ? record.domain : "";
        const state = typeof record.status === "string" ? record.status.toLowerCase() : "";
        const output = record.modalities?.output_modalities;
        const functions = record.features?.tools?.function_calling;
        const arkCatalog = provider === "custom" && (
          "domain" in record || "status" in record || "task_type" in record || "modalities" in record || "features" in record
        );
        if (arkCatalog) {
          // Ark returns a real capability/status catalog; prefer live text
          // generation models that can call tools, leaving vision-capable
          // chat models in while excluding image/video-generation products.
          suggested &&= !/(?:shutdown|retiring|disabled|offline)/.test(state);
          if (taskType.length) suggested &&= taskType.includes("TextGeneration");
          if (domain) suggested &&= !/(?:embedding|imagegeneration|videogeneration|3dgeneration|speech|audio)/i.test(domain);
          if (Array.isArray(output)) suggested &&= output.includes("text");
          if (typeof functions === "boolean") suggested &&= functions;
        }
        if (provider === "gemini") {
          if (Array.isArray(record.supportedGenerationMethods)) {
            suggested &&= record.supportedGenerationMethods.includes("generateContent");
          }
          suggested &&= !/(?:^|-)omni(?:-|$)/i.test(id);
        } else if (provider === "custom") {
          const genericOutput = record.architecture?.output_modalities;
          if (Array.isArray(genericOutput)) suggested &&= genericOutput.includes("text");
          // OpenRouter provides this field; other compatible APIs may omit it.
          if (Array.isArray(record.supported_parameters)) {
            suggested &&= record.supported_parameters.includes("tools");
          }
        }
      }
      const created = typeof record.created === "number" && Number.isFinite(record.created) ? record.created : 0;
      const context = typeof record.token_limits?.context_window === "number" ? record.token_limits.context_window : 0;
      const tools = record.features?.tools?.function_calling === true ||
        (Array.isArray(record.supported_parameters) && record.supported_parameters.includes("tools"));
      entries.set(id, {
        suggested,
        tools,
        created,
        context,
        preview: /(?:^|[-_])(?:preview|experimental|exp)(?:$|[-_])/i.test(id),
      });
    }
    const models = [...entries.keys()];
    const suggestedModels = models.filter((id) => entries.get(id)!.suggested);
    if (provider === "gemini") {
      const version = (id: string) => /-latest$/.test(id) ? Infinity : Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
      suggestedModels.sort((a, b) => {
        const va = version(a), vb = version(b);
        return (va === vb ? 0 : va > vb ? -1 : 1) || Number(entries.get(a)!.preview) - Number(entries.get(b)!.preview);
      });
    } else if (provider === "custom") {
      // Catalogs with capability metadata get an explicit AIbleton ranking:
      // tool support first, then the provider's newest active model release.
      suggestedModels.sort((a, b) => {
        const x = entries.get(a)!, y = entries.get(b)!;
        return Number(y.tools) - Number(x.tools) || y.created - x.created || y.context - x.context;
      });
    }
    return { models, suggestedModels, previewModels: models.filter((id) => entries.get(id)!.preview) };
  } catch {
    return empty;
  }
}

/**
 * Model catalog for the toolbar picker — the same models-list GETs the
 * connection probe makes, but returning the ids instead of a verdict.
 * Relays without /models fall back to Claude Code's configured mappings;
 * ChatGPT-account Codex uses the CLI's visible-model cache instead of the
 * API-key catalog. Neither path makes a generation call.
 */
export async function listModels(provider: Provider): Promise<ModelListResult> {
  const cfg = resolveConfig({ provider });
  try {
    if (provider === "claude") {
      if (!cfg.authToken) return { models: [], detail: "not configured" };
      const localModels = loadLocalModelIds(provider);
      try {
        const r = await fetchJson("GET", `${cfg.baseUrl}/v1/models`, {
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${cfg.authToken}`,
          "x-api-key": cfg.authToken,
        });
        if (classifyAuth(r.status)) return { models: [], detail: "auth expired" };
        if (r.status >= 200 && r.status < 300) {
          const catalog = pickerCatalog(provider, r.body);
          const models = [...new Set([...localModels, ...catalog.models])];
          return {
            ...catalog,
            models,
            localModels,
            suggestedModels: [...new Set([...localModels, ...catalog.suggestedModels])],
          };
        }
        return { models: localModels, detail: `HTTP ${r.status}` };
      } catch (err) {
        return { models: localModels, detail: errMessage(err).slice(0, 120) };
      }
    }
    if (provider === "codex") {
      if (cfg.chatgpt) {
        const models = loadLocalModelIds(provider);
        return models.length ? { models } : { models, detail: "Codex CLI model cache unavailable" };
      }
      if (!cfg.authToken) return { models: [], detail: "not configured" };
      const r = await getJson(new URL(`${cfg.baseUrl}/models`), {
        authorization: `Bearer ${cfg.authToken}`,
      });
      if (classifyAuth(r.status)) return { models: [], detail: "auth expired" };
      if (r.status >= 200 && r.status < 300) return pickerCatalog(provider, r.body);
      return { models: [], detail: `HTTP ${r.status}` };
    }
    if (provider === "gemini") {
      if (!cfg.authToken) return { models: [], detail: "not configured" };
      const target = new URL(`${cfg.baseUrl}/v1beta/models`);
      target.searchParams.set("pageSize", "1000");
      const records: unknown[] = [];
      const tokens = new Set<string>();
      for (;;) {
        const r = await getJson(target, { "x-goog-api-key": cfg.authToken });
        if (classifyAuth(r.status) || (r.status === 400 && /api[-_ ]?key/i.test(r.body))) {
          return { models: [], detail: "auth expired" };
        }
        if (r.status < 200 || r.status >= 300) return { models: [], detail: `HTTP ${r.status}` };
        const page = JSON.parse(r.body) as { models?: unknown[]; nextPageToken?: unknown };
        if (Array.isArray(page?.models)) records.push(...page.models);
        const next = typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
        if (!next) break;
        // A broken relay must not keep this free catalog request alive forever.
        if (tokens.has(next) || tokens.size >= 20) {
          return { ...pickerCatalog(provider, JSON.stringify({ models: records })), partial: true, detail: "catalog pagination incomplete" };
        }
        tokens.add(next);
        target.searchParams.set("pageToken", next);
      }
      return pickerCatalog(provider, JSON.stringify({ models: records }));
    }
    // custom: baseUrl alone is enough to ask for the catalog (keyless local).
    if (!cfg.baseUrl) return { models: [], detail: "not configured" };
    const r = await getJson(
      new URL(`${cfg.baseUrl}/models`),
      cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : {},
    );
    if (classifyAuth(r.status)) return { models: [], detail: "auth expired" };
    if (r.status >= 200 && r.status < 300) return pickerCatalog(provider, r.body);
    return { models: [], detail: `HTTP ${r.status}` };
  } catch (err) {
    return { models: [], detail: errMessage(err).slice(0, 120) };
  }
}

// ---------- Audio-generation providers ----------
//
// Same question, one hard constraint: generation is BILLED PER CALL, so no
// probe may ever produce audio. Every check below is free:
//   stable-audio / elevenlabs — official account-info GETs
//   minimax                   — an empty-body POST: MiniMax reports auth
//                               failures vs payload-validation failures
//                               differently, and validation rejects cost nothing
//   custom                    — bare GET on the request URL (POSTing the body
//                               template would trigger a billed generation)

/** MiniMax auth-failure phrasing inside its HTTP-200 base_resp envelope. */
const MINIMAX_AUTH_RE = /api[- ]?key|token|unauthor|forbidden|鉴权|认证|授权/i;

export async function testAudioConnection(cfg: AudioGenConfig | null): Promise<ConnTestResult> {
  if (cfg?.provider === "custom") {
    if (!cfg.baseUrl) return fail("not_configured");
    const auth = cfg.custom?.authHeader ?? "bearer";
    const headers: Record<string, string> =
      auth === "none" || !cfg.apiKey
        ? {}
        : auth === "x-api-key"
          ? { "x-api-key": cfg.apiKey }
          : { authorization: `Bearer ${cfg.apiKey}` };
    let r: { status: number; body: string };
    try {
      r = await getJson(new URL(cfg.baseUrl), headers);
    } catch (err) {
      return netFail(err);
    }
    const authFail = classifyAuth(r.status);
    if (authFail) return fail(authFail);
    // Any other answer proves host + path exist; whether the key is ACCEPTED
    // can't be learned without a billed generation.
    return ok(undefined, `endpoint answered HTTP ${r.status} — key verified only on first generation`);
  }
  if (!cfg) return fail("not_configured");

  if (cfg.provider === "minimax") {
    let r: { status: number; body: string };
    try {
      r = await postJson(
        new URL(`${cfg.baseUrl}/v1/music_generation`),
        { authorization: `Bearer ${cfg.apiKey}` },
        {}, // invalid payload on purpose — rejected at validation, never rendered
      );
    } catch (err) {
      return netFail(err);
    }
    const authFail = classifyAuth(r.status);
    if (authFail) return fail(authFail);
    try {
      const data = JSON.parse(r.body) as {
        base_resp?: { status_code?: number; status_msg?: string };
      };
      const code = data.base_resp?.status_code ?? 0;
      const msg = data.base_resp?.status_msg ?? "";
      if (MINIMAX_AUTH_RE.test(msg)) return fail("auth_expired", undefined, `code ${code}: ${msg}`.slice(0, 120));
      // Any other structured biz error (missing prompt, …) means the key was
      // accepted and the request reached business logic.
      return ok(undefined, code ? `key accepted (validation code ${code})` : undefined);
    } catch {
      return fail("error", undefined, `HTTP ${r.status}`);
    }
  }

  // stable-audio / elevenlabs: free account-info endpoints.
  const path = cfg.provider === "elevenlabs" ? "/v1/user" : "/v1/user/account";
  const headers: Record<string, string> =
    cfg.provider === "elevenlabs"
      ? { "xi-api-key": cfg.apiKey }
      : { authorization: `Bearer ${cfg.apiKey}` };
  let r: { status: number; body: string };
  try {
    r = await getJson(new URL(`${cfg.baseUrl}${path}`), headers);
  } catch (err) {
    return netFail(err);
  }
  const authFail = classifyAuth(r.status);
  if (authFail) return fail(authFail);
  if (r.status === 429) return ok(undefined, "rate limited (auth OK)");
  if (r.status >= 200 && r.status < 300) return ok();
  return fail("error", undefined, `HTTP ${r.status}`);
}
