import { URL } from "node:url";
import type { ResolvedConfig } from "./config.js";

export type SpeedKind = "openai" | "claude" | "gemini" | "router";
export type SpeedState = "requested" | "fast" | "standard" | "unknown" | "routing";
type SpeedConfig = Pick<ResolvedConfig, "provider" | "baseUrl" | "model" | "chatgpt" | "fastMode">;

/** Conservative allowlist: an OpenAI-compatible URL alone does not promise
 * paid service tiers. Keep unknown relays/local models' request shapes intact.
 * Sources: OpenAI fast-mode; Claude fast-mode; Gemini generate-content/
 * priority-inference; OpenRouter provider-selection official documentation. */
export function speedCapability(cfg: SpeedConfig): { kind: SpeedKind | null; reason?: "model" | "endpoint"; scope: string } {
  let host = "";
  let endpoint = "invalid";
  let pathname = "";
  try {
    const url = new URL(cfg.baseUrl);
    host = url.hostname.toLowerCase();
    pathname = url.pathname.replace(/\/+$/, "");
    endpoint = `${url.protocol}//${url.host}${pathname}`;
    if (url.protocol !== "https:") host = "";
  } catch { /* Invalid addresses never get vendor fields. */ }
  const scope = `${cfg.provider}:${endpoint}:${cfg.model}`;
  const result = (kind: SpeedKind | null, reason?: "model" | "endpoint") => ({ kind, reason, scope });
  const model = cfg.model.toLowerCase();
  if ((cfg.provider === "codex" || cfg.provider === "custom") &&
      ((host === "api.openai.com" && pathname === "/v1") ||
       (cfg.provider === "codex" && cfg.chatgpt && host === "chatgpt.com" && pathname === "/backend-api/codex"))) {
    return /^gpt-(?:5\.[456](?:-sol)?|6(?:\.1)?-(?:sol|astra|luna))(?:$|-\d{4}-\d{2}-\d{2}$)/.test(model)
      ? result("openai") : result(null, "model");
  }
  if (cfg.provider === "claude" && host === "api.anthropic.com" && pathname === "") {
    return /^claude-opus-(?:5-5|5|4-8)(?:$|-\d{8}$)/.test(model)
      ? result("claude") : result(null, "model");
  }
  if (cfg.provider === "gemini" && host === "generativelanguage.googleapis.com" && pathname === "") {
    return /^gemini-(?:2\.5-(?:pro|flash(?:-lite|-image)?)|3\.1-(?:flash-lite|pro-preview)|3\.(?:5|6|8)-flash(?:-lite)?|3-(?:flash|pro-image)-preview|4-argon|flash-latest)(?:$|-\d{2}-\d{2}$)/.test(model)
      ? result("gemini") : result(null, "model");
  }
  if (cfg.provider === "custom" && host === "openrouter.ai" && pathname === "/api/v1" && model) return result("router");
  return result(null, "endpoint");
}

export function speedRequestBody(cfg: SpeedConfig): Record<string, unknown> {
  const kind = speedCapability(cfg).kind;
  // An API project may itself default to Fast. Explicit off must override
  // that project setting rather than silently incur its premium.
  if (cfg.fastMode !== true) return cfg.fastMode === false && kind === "openai" && !cfg.chatgpt
    ? { service_tier: "default" } : {};
  switch (kind) {
    case "openai": return { service_tier: cfg.chatgpt ? "priority" : "fast" };
    case "claude": return { speed: "fast" };
    case "gemini": return { service_tier: "priority" };
    case "router": return { provider: { sort: "latency" } };
    default: return {};
  }
}

export function speedRequestHeaders(cfg: SpeedConfig, headers: Record<string, string>): Record<string, string> {
  if (cfg.fastMode === true && speedCapability(cfg).kind === "claude" &&
      /^claude-opus-(?:5|4-8)(?:$|-\d{8}$)/.test(cfg.model)) {
    const beta = [headers["anthropic-beta"], "fast-mode-2026-02-01"].filter(Boolean).join(",");
    return { ...headers, "anthropic-beta": beta };
  }
  return headers;
}

interface SpeedStatus {
  scope: string;
  kind: SpeedKind | null;
  state: SpeedState;
  roundCounts: { fast: number; standard: number; unknown: number; routing: number };
  lastReturnedTier?: string;
}
let status: SpeedStatus | null = null;
let results: SpeedState[] = [];

export function beginSpeedTurn(cfg: SpeedConfig): void {
  results = [];
  const capability = speedCapability(cfg);
  status = cfg.fastMode === true && capability.kind
    ? { scope: capability.scope, kind: capability.kind, state: "requested",
        roundCounts: { fast: 0, standard: 0, unknown: 0, routing: 0 } } : null;
}

export function getSpeedStatus(): SpeedStatus | null { return status; }

/** Only positive server evidence earns the 'fast' label. Aggregate across
 * rounds so a later fast response cannot hide a downgrade or missing evidence. */
export function recordSpeedResult(cfg: SpeedConfig, response: { service_tier?: unknown; usage?: unknown }, headerTier?: string): void {
  if (!status || cfg.fastMode !== true || status.scope !== speedCapability(cfg).scope) return;
  const usageSpeed = response.usage && typeof response.usage === "object" && "speed" in response.usage ? response.usage.speed : undefined;
  const tier = headerTier ?? usageSpeed ?? response.service_tier;
  const actual: SpeedState = status.kind === "router" ? "routing"
    : tier === "fast" || tier === "priority" ? "fast"
    : tier === "standard" || tier === "default" ? "standard" : "unknown";
  results.push(actual);
  const roundCounts = { ...status.roundCounts, [actual]: status.roundCounts[actual] + 1 };
  status = { ...status, roundCounts, lastReturnedTier: typeof tier === "string" ? tier : "missing",
    state: results.includes("standard") ? "standard"
    : results.includes("unknown") ? "unknown" : actual };
}
