import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMusicState } from "../../../analysis/interpret.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildSectionFeatures } from "../section.js";
import {
  audioClip,
  audioFeatures,
  fourOnFloor,
  midiClip,
  note,
  snapshot,
  stateWithAudio,
  track,
} from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

test("two identical sections → identical features (spec test 3)", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Kick", "midi", [
          midiClip("k1", fourOnFloor(1), { start: 0, duration: 32 }),
          midiClip("k2", fourOnFloor(1), { start: 32, duration: 32 }),
        ]),
      ],
      { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
    ),
  );
  const sections = buildSectionFeatures(state);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, "A");
  assert.equal(sections[1].name, "B");
  assert.equal(sections[0].density, 4); // 32 onsets / 8 bars
  assert.equal(sections[0].density, sections[1].density);
  assert.equal(sections[0].activeTrackRatio, 1);
  assert.equal(sections[0].activeTrackRatio, sections[1].activeTrackRatio);
  assert.deepEqual(sections[0].impact, sections[1].impact);
  assert.deepEqual(sections[0].energy, sections[1].energy);
});

test("kick-only vs kick+bass+sub: density ↑, lowEnergy ↑, activeTrackRatio ↑ (spec test 4)", () => {
  const snap = snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("kick", fourOnFloor(1), { start: 0, duration: 64 }),
      ]),
      track(1, "Bass", "midi", [
        midiClip("bass", [note(40, 0, 2), note(40, 2, 2)], { start: 32, duration: 32 }),
      ]),
      track(2, "Sub", "audio", [audioClip("sub", { start: 32, duration: 32 })]),
    ],
    { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
  );
  const state = stateWithAudio(snap, [
    {
      trackPos: 2,
      clipPos: 0,
      features: audioFeatures({
        bands: { sub: 0.5, bass: 0.2, lowMid: 0.1, mid: 0.1, highMid: 0.05, high: 0.05 },
      }),
    },
  ]);
  const [a, b] = buildSectionFeatures(state);
  assert.equal(a.density, 4); // kick only: 32 onsets / 8 bars
  assert.equal(b.density, 6); // kick 32 + bass 16 onsets / 8 bars
  assert.ok(b.density > a.density);
  close(a.activeTrackRatio, 1 / 3); // only the kick is audible in A
  assert.equal(b.activeTrackRatio, 1); // kick + bass + sub all sound in B
  // No analyzed audio overlaps section A → undefined, NEVER 0.
  assert.equal(a.lowEnergy, undefined);
  assert.equal(a.energyAudio, undefined);
  assert.equal(a.spectralBrightness, undefined);
  // Section B reads the sub's source file.
  close(b.lowEnergy?.value, 0.7); // sub 0.5 + bass 0.2
  assert.equal(b.lowEnergy?.source, "audio");
  assert.ok(b.lowEnergy !== undefined); // ↑ from section A's "no data"
  // Energy stays explainable: A is MIDI-only, B combines both.
  assert.equal(a.energy?.source, "derived");
  assert.ok(a.energyMidi !== undefined);
  assert.ok(b.energyAudio !== undefined);
  assert.ok((b.energy?.value ?? 0) > (a.energy?.value ?? 0));
});

test("muted clips do not leak into section features (spec test 5)", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Kick", "midi", [
          midiClip("k1", fourOnFloor(1), { start: 0, duration: 16 }),
          midiClip("k2", fourOnFloor(1), { start: 16, duration: 16, muted: true }),
        ]),
      ],
      { cuePoints: [{ time: 0, name: "A" }, { time: 16, name: "B" }] },
    ),
  );
  const sections = buildSectionFeatures(state);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].density, 4);
  // The muted second clip must not produce onsets, activity, or repetition.
  assert.equal(sections[1].density, 0);
  assert.equal(sections[1].activeTrackRatio, 0);
  assert.equal(sections[1].repetition, undefined);
  assert.equal(sections[1].rhythmicActivity, undefined);
});

test("loop clip: features count exactly what analysis heard (spec test 6)", () => {
  // 2-bar loop tiled over 8 bars → 4 passes × 8 notes = 32 audible onsets.
  const state = buildMusicState(
    snapshot([
      track(0, "Chords", "midi", [
        midiClip("ch", fourOnFloor(2), { duration: 32, loopStart: 0, loopEnd: 8 }),
      ]),
    ]),
  );
  const [section] = buildSectionFeatures(state);
  assert.equal(section.bars, 8);
  assert.equal(section.density, 4); // 32 onsets / 8 bars
  assert.equal(section.repetition, 0.75); // 1 pass of material, 4 audible
  assert.equal(section.variation, 0.25);
  // Cross-check against the interpretation layer's own section onset count —
  // MusicState materialization and MusicalFeatures must agree (spec ③).
  const analysis = analyzeMusicState(state);
  assert.equal(analysis.sections.length, 1);
  assert.equal(section.density * section.bars, analysis.sections[0].notes);
});

test("empty section: zeros from facts, undefined from missing analysis", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Kick", "midi", [
          midiClip("k", fourOnFloor(1), { start: 0, duration: 16 }),
        ]),
        // Muted tail extends the arrangement past the cue without sounding.
        track(1, "Tail", "audio", [
          audioClip("tail", { start: 24, duration: 8, muted: true }),
        ]),
      ],
      { cuePoints: [{ time: 0, name: "A" }, { time: 16, name: "B" }] },
    ),
  );
  const [a, b] = buildSectionFeatures(state);
  assert.equal(a.density, 4);
  // Section B genuinely has no notes: density 0 is a FACT, not missing data.
  assert.equal(b.density, 0);
  assert.equal(b.activeTrackRatio, 0);
  assert.equal(b.repetition, undefined);
  // Proxies still compute over the facts they have, with reduced confidence.
  assert.equal(b.impact?.value, 0);
  assert.equal(b.impact?.source, "derived");
  close(b.impact?.confidence, 0.45); // density + activeTrackRatio of 5 inputs
  assert.equal(b.energy?.value, 0);
  assert.equal(b.release?.value, 1);
  assert.equal(b.tension, undefined); // no rhythmic activity, no brightness
  assert.equal(b.lowEnergy, undefined);
});

test("provenance: derived proxies carry source and confidence", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [
        midiClip("k", fourOnFloor(1), { duration: 16 }),
      ]),
    ]),
  );
  const [s] = buildSectionFeatures(state);
  assert.equal(s.energyMidi?.source, "midi");
  assert.equal(s.energy?.source, "derived");
  assert.equal(s.impact?.source, "derived");
  assert.equal(s.rhythmicActivity?.source, "midi");
  for (const conf of [s.energy?.confidence, s.impact?.confidence]) {
    assert.ok(conf !== undefined && conf > 0 && conf <= 1);
  }
});
