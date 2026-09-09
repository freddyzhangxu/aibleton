import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicalFeatures } from "../index.js";
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

test("empty project: no crash, no invented numbers (spec test 1)", () => {
  const f = buildMusicalFeatures(buildMusicState(snapshot([])));
  assert.deepEqual(f.sections, []);
  assert.deepEqual(f.tracks, []);
  assert.equal(f.song.durationBeats, 0);
  assert.equal(f.song.bars, 0);
  assert.equal(f.song.trackCount, 0);
  assert.equal(f.song.midiTrackCount, 0);
  assert.equal(f.song.audioTrackCount, 0);
  assert.equal(f.song.tempo, 120);
  assert.equal(f.song.sectionCount, 0);
  // No sections → no averages and no energy stats (undefined, not 0).
  assert.equal(f.song.avgDensity, undefined);
  assert.equal(f.song.avgActiveTrackRatio, undefined);
  assert.equal(f.song.minEnergy, undefined);
  assert.equal(f.song.maxEnergy, undefined);
  assert.equal(f.song.energyRange, undefined);
});

test("song counts track types", () => {
  const f = buildMusicalFeatures(
    buildMusicState(
      snapshot([
        track(0, "Kick", "midi", [midiClip("k", fourOnFloor(1), { duration: 16 })]),
        track(1, "Bass", "midi", [midiClip("b", [note(40, 0, 4)], { duration: 16 })]),
        track(2, "Sub", "audio", [audioClip("s", { duration: 16 })]),
      ]),
    ),
  );
  assert.equal(f.song.trackCount, 3);
  assert.equal(f.song.midiTrackCount, 2);
  assert.equal(f.song.audioTrackCount, 1);
  assert.equal(f.song.durationBeats, 16);
  assert.equal(f.song.bars, 4);
  assert.equal(f.song.tempo, 120);
});

test("avgDensity / avgActiveTrackRatio average over all sections", () => {
  // Clip sounds in A only; a muted tail stretches the arrangement so B exists.
  const f = buildMusicalFeatures(
    buildMusicState(
      snapshot(
        [
          track(0, "Kick", "midi", [
            midiClip("k", fourOnFloor(1), { start: 0, duration: 32 }),
          ]),
          track(1, "Tail", "audio", [
            audioClip("tail", { start: 56, duration: 8, muted: true }),
          ]),
        ],
        { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
      ),
    ),
  );
  assert.equal(f.song.sectionCount, 2);
  assert.equal(f.sections[0].density, 4);
  assert.equal(f.sections[1].density, 0);
  assert.equal(f.song.avgDensity, 2);
  assert.equal(f.song.avgActiveTrackRatio, 0.5); // (1 + 0) / 2
});

test("energy stats come from the derived section energy", () => {
  // A is empty (energy 0 — a fact), B is dense (energy > 0).
  const f = buildMusicalFeatures(
    buildMusicState(
      snapshot(
        [
          track(0, "Kick", "midi", [
            midiClip("k", fourOnFloor(1), { start: 32, duration: 32 }),
          ]),
        ],
        { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
      ),
    ),
  );
  assert.equal(f.song.minEnergy, 0);
  assert.ok((f.song.maxEnergy ?? 0) > 0);
  close(f.song.energyRange, (f.song.maxEnergy ?? 0) - (f.song.minEnergy ?? 0));
});

test("deterministic: same MusicState → identical features (spec ①)", () => {
  const build = () =>
    stateWithAudio(
      snapshot(
        [
          track(0, "Kick", "midi", [
            midiClip("kick", fourOnFloor(1), { start: 0, duration: 64 }),
          ]),
          track(1, "Bass", "midi", [
            midiClip("bass", [note(40, 0, 2), note(43, 2, 2)], { start: 32, duration: 32 }),
          ]),
          track(2, "Sub", "audio", [audioClip("sub", { start: 32, duration: 32 })]),
        ],
        { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
      ),
      [{ trackPos: 2, clipPos: 0, features: audioFeatures() }],
    );
  const state = build();
  const f1 = buildMusicalFeatures(state);
  const f2 = buildMusicalFeatures(state);
  assert.deepEqual(f1, f2);
  // And a rebuilt-but-identical state produces the same features.
  assert.deepEqual(f1, buildMusicalFeatures(build()));
});
