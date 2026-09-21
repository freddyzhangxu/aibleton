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

test("makes named device replacement a verified sample-swap workflow", () => {
  assert.match(SYSTEM_PROMPT, /replace or swap a NAMED device\/instrument/);
  assert.match(SYSTEM_PROMPT, /do NOT call set_goal or set_plan/);
  assert.match(SYSTEM_PROMPT, /load_sample loads into an existing Simpler or inserts one itself/);
  assert.match(SYSTEM_PROMPT, /delete ONLY the named source device/);
  assert.match(SYSTEM_PROMPT, /get_simpler_sample to verify every target/);
});

test("uses the safe replacement tool for named built-in device swaps", () => {
  assert.match(SYSTEM_PROMPT, /replace_device/);
  assert.match(SYSTEM_PROMPT, /allow_delete_first/);
  assert.match(SYSTEM_PROMPT, /safe insertion.*fails/i);
});

test("keeps user bar ranges out of invented goal-section names", () => {
  assert.match(SYSTEM_PROMPT, /A user bar range is edit scope, not automatically a Section name/);
  assert.match(SYSTEM_PROMPT, /Never invent, merge, or normalize a Section name yourself/);
});
