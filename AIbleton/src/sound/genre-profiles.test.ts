import assert from "node:assert/strict";
import test from "node:test";

import { genreDrumProfilePrompt, genreInstrumentProfilePrompt } from "./genre-profiles.js";

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

test("maps Guitar roles to distinct sample timbres by subgenre and sound character", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Pop aliases:.*Guitar → clean electric guitar \(guitar_clean/);
  assert.match(guide, /Pop Rock overrides:.*Guitar → overdriven electric guitar \(guitar_overdrive/);
  assert.match(guide, /Jazz aliases:.*Guitar → clean electric guitar \(guitar_clean/);
  assert.match(guide, /Bossa Nova overrides:.*Guitar → acoustic\/nylon guitar \(guitar_acoustic/);
  assert.match(guide, /Funk aliases:.*Guitar → muted funk guitar \(guitar_muted/);
});

test("maps drum timbre by genre and filters guidance to requested roles", () => {
  const techno = genreDrumProfilePrompt("techno drums");
  assert.match(techno, /Techno aliases:.*Kick → tight, punchy, focused low end/);
  assert.match(techno, /Snare\/Clap → short, firm, restrained/);
  assert.match(techno, /Hi-hats → crisp, controlled high end/);

  const trap = genreDrumProfilePrompt("trap kick");
  assert.match(trap, /Trap aliases:.*Kick → deep, tuned 808-style low end/);
  assert.doesNotMatch(trap, /Snare\/Clap →/);
  assert.doesNotMatch(trap, /Hi-hats →/);
});

test("drum genre profiles guide timbre without prescribing parts or replacing explicit choices", () => {
  const guide = genreDrumProfilePrompt("house drums");
  assert.match(guide, /Use drum profiles only to guide timbre for parts already requested or present/);
  assert.match(guide, /Explicitly named drum timbres take precedence/);
  assert.match(guide, /Do not add, omit, or require drum parts or patterns from these profiles/);
});

test("explicit drum subgenres override parent timbres and inherit unlisted roles", () => {
  const techHouse = genreDrumProfilePrompt("tech house drums");
  assert.match(techHouse, /Tech House overrides House:.*Kick → tight, punchy, club-forward/);
  assert.doesNotMatch(techHouse, /Kick → rounded, warm, and steady/);
  assert.match(techHouse, /Snare\/Clap → short, dry, and clean/);

  const darkTechno = genreDrumProfilePrompt("dark techno drums");
  assert.match(darkTechno, /Dark Techno overrides Techno:.*Kick → heavy, controlled, dark low end/);
  assert.doesNotMatch(darkTechno, /Kick → tight, punchy, focused low end/);
});

test("unlisted drum subgenres keep the parent genre profile", () => {
  const guide = genreDrumProfilePrompt("house drums, deep and late-night");
  assert.match(guide, /House aliases:.*Kick → rounded, warm, and steady/);
  assert.doesNotMatch(guide, /Tech House overrides/);
  assert.doesNotMatch(guide, /Deep House overrides/);
});
