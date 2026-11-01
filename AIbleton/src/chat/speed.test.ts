import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig, type ChatRequest, type ResolvedConfig } from "./config.js";
import { toolHooks } from "../state.js";
import * as speed from "./speed.js";

// Explicit off must override a saved on; arbitrary truthy input must not spend
// extra money. Changing this precedence or accepting strings breaks this test.
test("speed is opt-in, persisted, and explicitly overridable without changing effort", () => {
  const original = toolHooks.getManualConfig;
  toolHooks.getManualConfig = () => ({ apiKey: "test", fastMode: true } as never);
  try {
    const enabled = resolveConfig({ provider: "gemini", effort: "high" }) as ResolvedConfig & { fastMode?: boolean };
    assert.equal(enabled.fastMode, true);
    const disabled = resolveConfig({ provider: "gemini", fastMode: false, effort: "high" } as ChatRequest) as typeof enabled;
    assert.equal(disabled.fastMode, false);
    assert.equal(disabled.effort, "high");
    toolHooks.getManualConfig = () => ({ apiKey: "test" });
    assert.equal((resolveConfig({ provider: "gemini", fastMode: "true" } as unknown as ChatRequest) as typeof enabled).fastMode, false);
  } finally { toolHooks.getManualConfig = original; }
});

const cfg = (provider: ResolvedConfig["provider"], baseUrl: string, model: string): ResolvedConfig => ({
  provider, baseUrl, model, authToken: "", fromLocal: false, fastMode: true,
});

test("paid speed fields are restricted to supported endpoint/model combinations", () => {
  assert.ok(speed, "speed policy is implemented");
  const openai = cfg("codex", "https://api.openai.com/v1", "gpt-5.6-sol");
  assert.deepEqual(speed.speedRequestBody(openai), { service_tier: "fast" });
  assert.deepEqual(speed.speedRequestBody({ ...openai, chatgpt: true, baseUrl: "https://chatgpt.com/backend-api/codex" }), { service_tier: "priority" });
  assert.deepEqual(speed.speedRequestBody({ ...openai, fastMode: false }), { service_tier: "default" });
  assert.deepEqual(speed.speedRequestBody({ ...openai, baseUrl: "https://relay.example/v1" }), {});
  assert.deepEqual(speed.speedRequestBody({ ...openai, model: "gpt-5.3-codex" }), {});
  const claude = cfg("claude", "https://api.anthropic.com", "claude-opus-5-5");
  assert.deepEqual(speed.speedRequestBody(claude), { speed: "fast" });
  assert.deepEqual(speed.speedRequestBody({ ...claude, model: "claude-sonnet-5" }), {});
  assert.deepEqual(speed.speedRequestHeaders({ ...claude, model: "claude-opus-4-8" }, { "anthropic-beta": "oauth-2025-04-20" }), {
    "anthropic-beta": "oauth-2025-04-20,fast-mode-2026-02-01",
  });
  assert.deepEqual(speed.speedRequestBody(cfg("gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-flash")), { service_tier: "priority" });
  assert.deepEqual(speed.speedRequestBody(cfg("custom", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat")), { provider: { sort: "latency" } });
  assert.deepEqual(speed.speedRequestBody(cfg("custom", "https://api.deepseek.com", "deepseek-flash")), {});
  assert.deepEqual(speed.speedRequestBody(cfg("gemini", "not a URL", "gemini-flash-latest")), {});
});

test("actual speed distinguishes missing evidence from server downgrade across rounds", () => {
  assert.ok(speed);
  const openai = cfg("codex", "https://api.openai.com/v1", "gpt-5.6-sol");
  speed.beginSpeedTurn(openai);
  assert.equal(speed.getSpeedStatus()?.state, "requested");
  speed.recordSpeedResult(openai, {});
  assert.equal(speed.getSpeedStatus()?.state, "unknown");
  speed.recordSpeedResult(openai, { service_tier: "priority" });
  assert.equal(speed.getSpeedStatus()?.state, "unknown", "a later fast round must not conceal an unverified round");
  speed.recordSpeedResult(openai, { service_tier: "default" });
  assert.equal(speed.getSpeedStatus()?.state, "standard");
  speed.recordSpeedResult(openai, { service_tier: "fast" });
  assert.equal(speed.getSpeedStatus()?.state, "standard", "a later fast round must not conceal a downgrade");
  speed.beginSpeedTurn(openai);
  speed.recordSpeedResult(openai, { service_tier: "fast" });
  assert.equal(speed.getSpeedStatus()?.state, "fast");
  const gemini = cfg("gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-flash");
  speed.beginSpeedTurn(gemini);
  speed.recordSpeedResult(gemini, {}, "standard");
  assert.equal(speed.getSpeedStatus()?.state, "standard");
  const claude = cfg("claude", "https://api.anthropic.com", "claude-opus-5-5");
  speed.beginSpeedTurn(claude);
  speed.recordSpeedResult(claude, { usage: { speed: "fast" } });
  assert.equal(speed.getSpeedStatus()?.state, "fast");
  speed.beginSpeedTurn({ ...claude, fastMode: false });
  assert.equal(speed.getSpeedStatus(), null);
});

test("mixed fast and standard rounds retain counts and the raw returned tier", () => {
  const config = cfg("codex", "https://chatgpt.com/backend-api/codex", "gpt-6.1-sol");
  config.chatgpt = true;
  speed.beginSpeedTurn(config);
  speed.recordSpeedResult(config, { service_tier: "priority" });
  speed.recordSpeedResult(config, { service_tier: "default" });
  const status = speed.getSpeedStatus() as ReturnType<typeof speed.getSpeedStatus> & { roundCounts?: unknown; lastReturnedTier?: string };
  assert.deepEqual(status?.roundCounts, { fast: 1, standard: 1, unknown: 0, routing: 0 });
  assert.equal(status?.lastReturnedTier, "default");
});
