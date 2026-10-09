import assert from "node:assert/strict";
import test from "node:test";

import { genreInstrumentProfilePrompt } from "./genre-profiles.js";

test("profile guide distinguishes core and optional parts and gives subgenres precedence", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Core parts/);
  assert.match(guide, /Optional parts/);
  assert.match(guide, /An explicit subgenre overrides the parent genre for listed roles/);
  assert.match(guide, /If no listed subgenre matches, retain the parent genre profile/);
  assert.match(guide, /Leave unsupported role and genre combinations unresolved and ask one concise question/);
});

test("profile guide derives recipe source and fallback from the recipe catalog", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /rock_bass, sample; fallback Operator/);
  assert.match(guide, /keys_dx7_synth, synth Operator; fallback Operator/);
});
