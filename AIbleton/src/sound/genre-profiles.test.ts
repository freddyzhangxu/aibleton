import assert from "node:assert/strict";
import test from "node:test";

import { genreInstrumentProfilePrompt } from "./genre-profiles.js";

test("profile guide maps sound by role and gives subgenres precedence", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Role-to-sound mappings: Bass/);
  assert.match(guide, /An explicit subgenre overrides the parent genre for listed roles/);
  assert.match(guide, /If no listed subgenre matches, retain the parent genre profile/);
  assert.match(guide, /For an unlisted role, keep the selected role and use normal role-specific defaults or current Set context/);
  assert.doesNotMatch(guide, /Core parts:|Optional parts:/);
});

test("profile guide derives recipe source and fallback from the recipe catalog", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /rock_bass, sample; fallback Operator/);
  assert.match(guide, /keys_dx7_synth, synth Operator; fallback Operator/);
});

test("profiles resolve representative parent genres and subgenres", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Pop aliases:.*Lead → clean rounded synth lead \(lead_clean/);
  assert.match(guide, /Pop aliases:.*Pluck → bell-like synth pluck \(pluck_bell/);
  assert.match(guide, /Pop Rock.*rock_bass/);
  assert.match(guide, /Dance Pop.*electronic_bass/);
  assert.match(guide, /Synth Pop.*keys_dx7_synth/);
  assert.match(guide, /Straight-ahead Jazz.*jazz_bass/);
  assert.match(guide, /Jazz Fusion.*jazz_fusion_bass/);
  assert.match(guide, /Bossa Nova.*bossa_bass/);
  assert.match(guide, /Funk Slap.*funk_slap_bass/);
  assert.match(guide, /Funk Pick.*funk_pick_bass/);
  assert.match(guide, /Disco Funk.*lead_analog/);
  assert.match(guide, /Modern R&B.*hiphop_808_bass/);
  assert.match(guide, /Neo-Soul.*pop_bass.*sample/);
  assert.match(guide, /Trap-influenced R&B.*hiphop_808_bass/);
  assert.match(guide, /R&B aliases: R&B, R and B, rhythm and blues/);
  assert.match(guide, /Jazz Fusion aliases: jazz fusion, fusion/);
});

test("contextual Pop Bass exposes sample and synth preferences", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Pop aliases:[\s\S]*Bass → electric bass when band\/acoustic arrangement \(pop_bass, contextual source; fallback Operator; prefer sample\)/);
  assert.match(guide, /synth bass when synth\/dance arrangement \(pop_bass, contextual source; fallback Operator; prefer synth\)/);
});

test("genre profiles guide timbre for selected roles without constraining the role lineup", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Use profiles only to choose an instrument or timbre for a role already selected by the user or arrangement/);
  assert.match(guide, /Never add, omit, require, or forbid parts because of a genre profile/);
  assert.doesNotMatch(guide, /Core parts:|Optional parts:/);
});
