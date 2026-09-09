import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildSectionSimilarities } from "../similarity.js";
import {
  audioClip,
  audioFeatures,
  densityShapeSong,
  snapshot,
  stateWithAudio,
  track,
} from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

test("identical sections → similarity 1, repeat, MIDI-only coverage", () => {
  const [s] = buildSectionSimilarities(densityShapeSong([4, 4]));
  close(s.similarity.value, 1);
  assert.equal(s.kind, "repeat");
  assert.equal(s.similarity.source, "derived");
  close(s.similarity.confidence, 4 / 7); // density+atr+rhythmic+repetition of 7
});

test("sparse vs dense → different, exact weighted mean", () => {
  const [s] = buildSectionSimilarities(densityShapeSong([1, 16]));
  // dims: densityN 0.0625 vs 1 → 0.0625; atr 1; rhythmic = densityN → 0.0625;
  // repetition 0.875 both → 1. (0.0625 + 1 + 0.0625 + 1) / 4
  close(s.similarity.value, 0.53125);
  assert.equal(s.kind, "different");
  close(s.similarity.confidence, 4 / 7);
});

test("two genuinely empty sections are identical — on 2/7 of the evidence", () => {
  const [s] = buildSectionSimilarities(densityShapeSong([0, 0]));
  close(s.similarity.value, 1);
  assert.equal(s.kind, "repeat");
  close(s.similarity.confidence, 2 / 7); // only density + activeTrackRatio
});

test("reprise detection: S0≈S2 repeat while neighbors differ", () => {
  const sims = buildSectionSimilarities(densityShapeSong([4, 16, 4]));
  assert.equal(sims.length, 3);
  // Unordered pairs, ids in numeric order, one entry per pair.
  assert.deepEqual(
    sims.map((s) => [s.aSectionId, s.bSectionId]),
    [
      ["0", "1"],
      ["0", "2"],
      ["1", "2"],
    ],
  );
  assert.equal(sims[1].kind, "repeat"); // the reprise
  assert.equal(sims[0].kind, "different");
  assert.equal(sims[2].kind, "different");
});

test("analyzed audio sections: all band/brightness dims join the evidence", () => {
  const snap = snapshot(
    [
      track(0, "Sub", "audio", [
        audioClip("s1", { start: 0, duration: 32 }),
        audioClip("s2", { start: 32, duration: 32 }),
      ]),
    ],
    { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
  );
  const state = stateWithAudio(snap, [
    { trackPos: 0, clipPos: 0, features: audioFeatures() },
    { trackPos: 0, clipPos: 1, features: audioFeatures() },
  ]);
  const [s] = buildSectionSimilarities(buildMusicalFeatures(state));
  close(s.similarity.value, 1);
  assert.equal(s.kind, "repeat");
  // density + atr + rhythmic(transients) + low + mid(0.5) + high + brightness(0.5)
  close(s.similarity.confidence, 6 / 7);
});
