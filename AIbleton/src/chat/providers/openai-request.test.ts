import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedConfig } from "../config.js";

import * as requests from "./openai-request.js";
const cfg: ResolvedConfig = { provider: "codex", model: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api/codex", chatgpt: true, authToken: "", fromLocal: false, reasoningEffort: "high", fastMode: true };

test("native rounds reuse a stable cache key and request encrypted reasoning without lowering effort", () => {
  assert.ok(requests, "native request builder exists");
  const first = requests.buildOpenAIRequest(cfg, { systemPrompt: "test instructions" }, [{role:"user",content:"test"}], [], "session-a");
  assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(first.reasoning, {effort:"high"});
  assert.equal(first.store, false);
  assert.equal(first.service_tier, "priority");
  assert.equal(first.parallel_tool_calls, true);
  const replay = [{type:"reasoning",id:"rs_test",encrypted_content:"opaque-state",summary:[]},{type:"function_call",name:"test_tool",call_id:"call_1",arguments:"{}"},{type:"function_call_output",call_id:"call_1",output:"done"}];
  const second = requests.buildOpenAIRequest(cfg, {systemPrompt:"test instructions"}, replay, [], "session-a");
  assert.equal(second.prompt_cache_key, first.prompt_cache_key);
  assert.deepEqual(second.input, replay);
  assert.notEqual(requests.buildOpenAIRequest(cfg, {systemPrompt:"test"}, [], [], "session-b").prompt_cache_key, first.prompt_cache_key);
  assert.ok(String(first.prompt_cache_key).length <= 64);
});

test("unknown Responses relays keep their existing fields and receive no cache or reasoning extensions", () => {
  assert.ok(requests);
  const body = requests.buildOpenAIRequest({...cfg,baseUrl:"https://relay.example/v1",chatgpt:false}, {systemPrompt:"test"}, [], [], "session-a");
  assert.equal(body.include, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.parallel_tool_calls, undefined);
  assert.deepEqual(body.reasoning,{effort:"high"});
});
