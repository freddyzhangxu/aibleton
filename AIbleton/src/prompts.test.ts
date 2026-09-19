import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT } from "./prompts.js";

test("keeps track indices internal and presents user-facing tracks one-based", () => {
  assert.match(SYSTEM_PROMPT, /0-based INTERNAL tool coordinates/);
  assert.match(SYSTEM_PROMPT, /“first track” \/ “第一轨” means track_index 0/);
  assert.match(SYSTEM_PROMPT, /one-based ordinal and current name/);
  assert.match(SYSTEM_PROMPT, /“Track 1 \(Drums\)” or “第 1 轨（Drums）”/);
  assert.match(SYSTEM_PROMPT, /Never expose a bare raw track index/);
});
