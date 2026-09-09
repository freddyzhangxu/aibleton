/**
 * Edge-case review tests (PR11 second pass) — the risk these pin is not
 * architecture but NUMERICAL SEMANTICS: do the computed features actually
 * agree with what MusicState says sounds?
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicalFeatures } from "../index.js";
import {
  LOUDNESS_DB_HI,
  LOUDNESS_DB_LO,
  normRange,
} from "../normalize.js";
import { buildSectionFeatures } from "../section.js";
import { buildTrackFeatures } from "../track.js";
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

// ---------------------------------------------------------------- case 1 ---
// Looping clip whose duration is NOT an exact multiple of the loop: the
// final pass is truncated by Live, and MusicState accounts for it with
// fractional repeats. Features must agree with MusicState (10 audible
// onsets), not with ceil-tiles (12).
test("fractional loop: final pass truncated, agrees with MusicState audibleNotes", () => {
  // 4-beat loop (4 notes), 10-beat clip → 2.5 passes: 4 + 4 + 2 onsets.
  const state = buildMusicState(
    snapshot([
      track(0, "Kick", "midi", [
        midiClip("k", fourOnFloor(1), { duration: 10 }),
      ]),
    ]),
  );
  const audible = state.tracks[0].measurements?.audibleNotes;
  assert.equal(audible, 10); // round(4 × 2.5) — the MusicState truth

  const [section] = buildSectionFeatures(state);
  close(section.bars, 2.5);
  close(section.density * section.bars, audible!); // features hear the same 10
  close(section.density, 4); // 10 onsets / 2.5 bars

  const [t] = buildTrackFeatures(state);
  close(t.repetition, 0.6); // (10 − 4) / 10 — truncated, not (12 − 4) / 12
});

// ---------------------------------------------------------------- case 4 ---
// Audio-only section with NO analysis: MIDI-derived silence must not be
// treated as evidence about the section's energy.
test("audio-only section, unanalyzed: energy unknown, not fabricated", () => {
  const state = buildMusicState(
    snapshot([track(0, "Sub", "audio", [audioClip("sub", { duration: 16 })])]),
  );
  const [s] = buildSectionFeatures(state);
  assert.equal(s.density, 0); // fact: no notes
  assert.equal(s.activeTrackRatio, 1); // fact: the clip sounds here
  assert.equal(s.lowEnergy, undefined); // never analyzed ≠ no low end
  assert.equal(s.rhythmicActivity, undefined);
  // The MIDI energy proxy has no jurisdiction in an audio-active section.
  assert.equal(s.energyMidi, undefined);
  assert.equal(s.energyAudio, undefined);
  assert.equal(s.energy, undefined); // "we don't know", not 0.33
  assert.equal(s.tension, undefined);
  // Uniform proxy contract: impact/release still compute over the facts
  // they have (density 0, ratio 1), flagged by reduced confidence.
  assert.ok(s.impact !== undefined);
  assert.ok((s.impact?.confidence ?? 1) < 1);
});

// ---------------------------------------------------------------- case 5 ---
// Session-only clips: not on the arrangement timeline → no timeline
// features, but also no crash and no fake zeros.
test("session-only clip: no arrangement features, no crash", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Ideas", "midi", [
        midiClip("idea", fourOnFloor(1), { start: null, duration: 4 }),
      ]),
    ]),
  );
  const f = buildMusicalFeatures(state);
  assert.equal(f.sections.length, 0); // arrangement is empty
  assert.equal(f.song.durationBeats, 0);
  const [t] = f.tracks;
  assert.equal(t.activeRatio, 0); // nothing on the timeline
  assert.equal(t.density, undefined); // session material is not timeline density
  assert.equal(t.repetition, undefined);
  assert.equal(t.rhythmicActivity, undefined);
});

// ---------------------------------------------------------------- case 9 ---
// Zero-note MIDI: a clip with no notes (or no notes inside its loop window)
// sounds nothing — it is not "audible material" anywhere.
test("zero-note MIDI clip sounds nothing", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Empty", "midi", [midiClip("e", [], { duration: 16 })]),
      track(1, "Outside", "midi", [
        // Notes exist but lie entirely outside the 1-bar loop window.
        midiClip("o", [note(60, 8), note(64, 10)], { duration: 16 }),
      ]),
    ]),
  );
  const tracks = buildTrackFeatures(state);
  for (const t of tracks) {
    assert.equal(t.density, undefined); // no audible material → no density
    assert.equal(t.activeRatio, 0);
    assert.equal(t.repetition, undefined);
  }
  const [s] = buildSectionFeatures(state);
  assert.equal(s.density, 0); // fact: nothing sounds
  assert.equal(s.activeTrackRatio, 0); // neither track counts as audible
});

// ---------------------------------------------------------------- case 8 ---
// Partial audio analysis: aggregates describe only the analyzed share, and
// confidence must say so — track level and section level.
test("partial audio analysis: confidence carries the coverage share", () => {
  // Track level: two 4-bar audio clips, only the first analyzed.
  const trackState = buildMusicState(
    snapshot([
      track(0, "Stem", "audio", [
        audioClip("a", { start: 0, duration: 16 }),
        audioClip("b", { start: 16, duration: 16 }),
      ]),
    ]),
  );
  trackState.tracks[0].clips[0].audio = { features: audioFeatures() };
  // Second clip: attempted but failed — counts as uncovered, not as silent.
  trackState.tracks[0].clips[1].audio = { error: "decode failed" };
  const [t] = buildTrackFeatures(trackState);
  close(t.lowEnergy?.value, 0.3); // from the analyzed clip only
  close(t.lowEnergy?.confidence, 0.5); // 16 of 32 audible beats analyzed

  // Section level: same setup, one section spanning both clips.
  const [s] = buildSectionFeatures(trackState);
  close(s.lowEnergy?.value, 0.3);
  close(s.lowEnergy?.confidence, 0.5);
  close(s.energyAudio?.confidence, 0.5);
});

// ------------------------------------------------- audio overlap weighting ---
// The section audio pass must combine spectra the way spectra actually
// combine: by ENERGY. A whisper-quiet clip overlapping the same section as a
// loud one must not pull the section's band balance toward its own spectrum.
test("audio overlap: bands are energy-weighted, loud clip dominates", () => {
  const state = buildMusicState(
    snapshot([
      track(0, "Quiet", "audio", [audioClip("q", { start: 0, duration: 16 })]),
      track(1, "Loud", "audio", [audioClip("l", { start: 16, duration: 16 })]),
    ]),
  );
  // Quiet clip: rms −40 dB, high-heavy spectrum.
  state.tracks[0].clips[0].audio = {
    features: audioFeatures({
      rmsDb: -40,
      loudnessDb: -42,
      bands: { sub: 0, bass: 0, lowMid: 0.1, mid: 0.1, highMid: 0.4, high: 0.4 },
    }),
  };
  // Loud clip: rms −6 dB, sub-heavy spectrum. Energy ratio ≈ 2500:1.
  state.tracks[1].clips[0].audio = {
    features: audioFeatures({
      rmsDb: -6,
      loudnessDb: -9,
      bands: { sub: 0.6, bass: 0.3, lowMid: 0.05, mid: 0.05, highMid: 0, high: 0 },
    }),
  };
  const [s] = buildSectionFeatures(state);
  // NOT the naive mean (0.3) — the loud clip's 0.9, within a tight tolerance.
  close(s.lowEnergy?.value, 0.9, 0.01);
  assert.equal(s.lowEnergy?.confidence, 1); // full overlap coverage
  assert.equal(s.activeTrackRatio, 1); // both clips sound in the section
  // Duration-weighted loudness is the documented dB-domain mean (−25.5 dB).
  close(s.energyAudio?.value, normRange(-25.5, LOUDNESS_DB_LO, LOUDNESS_DB_HI), 1e-9);
});

// --------------------------------------------------------------- case 10 ---
// Very short sections: density per bar spikes by construction; normalized
// features must clamp, nothing may blow up.
test("1-beat section: raw density is honest, normalized features clamp", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Hit", "midi", [
          midiClip("h", [note(60, 0, 0.25), note(62, 0.25, 0.25), note(64, 0.5, 0.25), note(65, 0.75, 0.25)], {
            duration: 32,
            looping: false,
            loopStart: 0,
            loopEnd: 32,
          }),
        ]),
      ],
      { cuePoints: [{ time: 0, name: "hit" }, { time: 1, name: "rest" }] },
    ),
  );
  const [hit, rest] = buildSectionFeatures(state);
  close(hit.bars, 0.25);
  close(hit.density, 16); // 4 onsets in one beat = 16/bar — honest raw ratio
  assert.equal(hit.rhythmicActivity?.value, 1); // clamped at the 16/bar anchor
  assert.ok((hit.impact?.value ?? 2) <= 1);
  assert.equal(rest.density, 0);
});

// Duplicate cue times produce zero-length sections in sectionize; analysis
// skips them implicitly (no onset can land inside), features must drop them
// explicitly so the two layers stay aligned.
test("duplicate cue times: zero-length section dropped", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Kick", "midi", [
          midiClip("k", fourOnFloor(1), { duration: 32 }),
        ]),
      ],
      {
        cuePoints: [
          { time: 0, name: "A" },
          { time: 16, name: "dup1" },
          { time: 16, name: "dup2" },
        ],
      },
    ),
  );
  const sections = buildSectionFeatures(state);
  assert.equal(sections.length, 2);
  assert.ok(sections.every((s) => s.bars > 0));
  // sectionize pairs cue i with cue i+1: dup1 gets the zero-length [16,16)
  // span and is dropped; dup2 survives with [16, 32).
  assert.deepEqual(
    sections.map((s) => s.name),
    ["A", "dup2"],
  );
});
