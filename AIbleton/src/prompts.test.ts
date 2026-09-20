import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT, systemPromptFor } from "./prompts.js";

test("keeps track indices internal and presents user-facing tracks one-based", () => {
  assert.match(SYSTEM_PROMPT, /0-based INTERNAL tool coordinates/);
  assert.match(SYSTEM_PROMPT, /“first track” maps to track_index 0/);
  assert.match(SYSTEM_PROMPT, /one-based ordinal and current name/);
  assert.match(SYSTEM_PROMPT, /“Track 1 \(Drums\)”, translated into the turn's reply language/);
  assert.match(SYSTEM_PROMPT, /Never expose a bare raw track index/);
  assert.doesNotMatch(SYSTEM_PROMPT, /[\u3400-\u9fff]/u);
});

test("injects one explicit reply language for the turn", () => {
  const prompt = systemPromptFor("es");
  assert.match(prompt, /Reply language for this turn: Spanish \(es\)/);
  assert.match(prompt, /Use Spanish for all user-facing prose/);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});
