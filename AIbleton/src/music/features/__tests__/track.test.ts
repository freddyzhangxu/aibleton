import assert from "node:assert/strict";
import { test } from "node:test";
import type { MusicAnalysis } from "../../../analysis/types.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildTrackFeatures } from "../track.js";
import {
  audioClip,
  audioFeatures,
  fourOnFloor,
  midiClip,
  snapshot,
  stateWithAudio,
  track,
} from "./fixtures.js";

test("single track, single looped clip (spec test 2)", () => {
  // 1-bar 4-on-floor loop, 4 bars long → 16 audible notes over a 4-bar span.
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [
        midiClip("kick", fourOnFloor(1), { duration: 16 }),
      ]),
    ]),
  );
  const [t] = buildTrackFeatures(state);
  assert.equal(t.trackId, "0");
  assert.equal(t.name, "Kick");
  assert.equal(t.muted, false);
  assert.equal(t.density, 4); // 16 notes / 4 bars
  assert.equal(t.activeRatio, 1); // clip spans the whole arrangement
  assert.equal(t.pitchRange, 0);
  assert.equal(t.velocityRange, 0);
  assert.equal(t.repetition, 0.75); // 1 pass of material, 4 passes audible
  assert.equal(t.variation, 0.25);
  assert.deepEqual(t.rhythmicActivity, { value: 0.25, source: "midi" }); // 4/16
  // No audio analysis → undefined, never a fake 0 (spec rule).
  assert.equal(t.lowEnergy, undefined);
  assert.equal(t.midEnergy, undefined);
  assert.equal(t.highEnergy, undefined);
  assert.equal(t.transientDensity, undefined);
  // No MusicAnalysis given → no role label.
  assert.equal(t.role, undefined);
});

test("muted clip contributes nothing audible (spec test 5)", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [
        midiClip("kick", fourOnFloor(1), { duration: 16, muted: true }),
      ]),
    ]),
  );
  const [t] = buildTrackFeatures(state);
  assert.equal(t.density, undefined);
  assert.equal(t.pitchRange, undefined);
  assert.equal(t.repetition, undefined);
  assert.equal(t.rhythmicActivity, undefined);
  assert.equal(t.activeRatio, 0);
});

test("muted track contributes nothing audible (spec test 5)", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [midiClip("kick", fourOnFloor(1), { duration: 16 })], {
        mute: true,
      }),
    ]),
  );
  const [t] = buildTrackFeatures(state);
  assert.equal(t.muted, true);
  assert.equal(t.density, undefined);
  assert.equal(t.activeRatio, 0);
});

test("audio track: audio-sourced features, MIDI fields stay undefined", () => {
  const state = stateWithAudio(
    snapshot([
      track(0, "Sub", "audio", [audioClip("sub", { duration: 16 })]),
    ]),
    [{ trackPos: 0, clipPos: 0, features: audioFeatures() }],
  );
  const [t] = buildTrackFeatures(state);
  // No note facts → undefined, not 0.
  assert.equal(t.density, undefined);
  assert.equal(t.pitchRange, undefined);
  assert.equal(t.velocityRange, undefined);
  assert.equal(t.repetition, undefined);
  // Source-file aggregates with provenance. Values pass through the weighted
  // aggregation, so compare with tolerance; provenance is exact.
  const close = (v: number | undefined, expected: number) => {
    assert.ok(v !== undefined, "expected a value");
    assert.ok(Math.abs(v - expected) < 1e-9, `${v} ≉ ${expected}`);
  };
  close(t.lowEnergy?.value, 0.3); // sub+bass
  close(t.midEnergy?.value, 0.4); // lowMid+mid
  close(t.highEnergy?.value, 0.3); // highMid+high
  assert.equal(t.lowEnergy?.source, "audio");
  close(t.transientDensity?.value, 4);
  assert.equal(t.transientDensity?.source, "audio");
  // 4 onsets/sec × 2 sec/bar (120 BPM, 4/4) = 8 onsets/bar → 8/16.
  close(t.rhythmicActivity?.value, 0.5);
  assert.equal(t.rhythmicActivity?.source, "audio");
  assert.equal(t.activeRatio, 1);
});

test("audio clip without analysis: no audio features, but still occupies time", () => {
  const state = buildMusicState(
    snapshot([track(0, "Sub", "audio", [audioClip("sub", { duration: 16 })])]),
  );
  const [t] = buildTrackFeatures(state);
  assert.equal(t.lowEnergy, undefined); // never analyzed ≠ no low end
  assert.equal(t.rhythmicActivity, undefined);
  assert.equal(t.activeRatio, 1); // the clip still sounds
});

test("role labels arrive only via the optional MusicAnalysis", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [midiClip("kick", fourOnFloor(1), { duration: 16 })]),
    ]),
  );
  const analysis: MusicAnalysis = {
    key: { status: "insufficient_material" },
    sections: [],
    trackRoles: [{ i: 0, role: "kick", isDrums: true }],
    issues: [],
  };
  const [withRole] = buildTrackFeatures(state, analysis);
  assert.equal(withRole.role, "kick");
  const [without] = buildTrackFeatures(state);
  assert.equal(without.role, undefined);
});
