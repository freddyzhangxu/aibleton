import assert from "node:assert/strict";
import test from "node:test";

import { genreDrumProfilePrompt, genreInstrumentProfilePrompt } from "./genre-profiles.js";

test("genre profiles expose source choices and subgenre precedence without timbre recipes", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Role-to-source mappings: Bass → sample/);
  assert.match(guide, /An explicit subgenre overrides the parent genre only for source selections it changes/);
  assert.match(guide, /If no listed subgenre matches, retain the parent genre profile/);
  assert.match(guide, /For an unlisted role, choose a suitable source using musical judgment/);
  assert.match(guide, /Use profiles as suggestions only for sample versus synth or a named built-in synth source/);
  assert.doesNotMatch(guide, /warm synth pluck|clean electric guitar|analog synth lead|Clavinet-style/);
});

test("profile source names derive from the recipe catalog", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Rock aliases:.*Bass → sample/);
  assert.match(guide, /Keys → synth Operator/);
  assert.doesNotMatch(guide, /rock_bass|keys_dx7_synth|fallback Operator/);
});

test("profiles retain source choices across parent genres and subgenres", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Pop aliases:.*Lead → synth Drift/);
  assert.match(guide, /Pop Rock overrides: Bass → sample/);
  assert.match(guide, /Dance Pop overrides: Bass → synth Operator/);
  assert.match(guide, /Straight-ahead Jazz overrides: Bass → sample/);
  assert.match(guide, /Jazz Fusion overrides: Bass → sample/);
  assert.match(guide, /Bossa Nova overrides: Bass → sample/);
  assert.match(guide, /Funk Slap overrides: Bass → sample/);
  assert.match(guide, /Neo-Soul overrides: Bass → sample/);
  assert.doesNotMatch(guide, /bright|warm|airy|analog|aggressive|overdriven/);
});

test("contextual Pop Bass exposes sample and synth source preferences", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Bass → sample when band\/acoustic arrangement/);
  assert.match(guide, /synth Operator when synth\/dance arrangement/);
});

test("drum guidance selects sample sources without specifying pad timbres", () => {
  const guide = genreDrumProfilePrompt("house drums");
  assert.match(guide, /Drum kits and individual drum samples are sample sources/);
  assert.match(guide, /genre is a source-selection hint only/);
  assert.match(guide, /Do not prescribe per-pad synthesis or specific envelope, filter, or effect settings/);
  assert.match(guide, /Drum guidance does not require or prohibit parts or patterns/);
  assert.doesNotMatch(guide, /rounded, warm|crisp, controlled|club-forward/);
});

test("drum source guidance is included only for drum requests", () => {
  assert.equal(genreDrumProfilePrompt("make a soft pad"), "");
  assert.notEqual(genreDrumProfilePrompt("techno kick"), "");
});
