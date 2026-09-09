import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildSectionContrasts } from "../contrast.js";
import {
  audioClip,
  densityShapeSong,
  fourOnFloor,
  midiClip,
  snapshot,
  track,
} from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

test("identical sections → zero deltas, steady, energy basis", () => {
  const contrasts = buildSectionContrasts(densityShapeSong([4, 4]));
  assert.equal(contrasts.length, 1);
  const c = contrasts[0];
  assert.equal(c.fromSectionId, "0");
  assert.equal(c.toSectionId, "1");
  assert.equal(c.energyDelta?.value, 0);
  assert.equal(c.energyDelta?.source, "derived");
  assert.equal(c.energyDelta?.confidence, 0.5); // min of two MIDI-only energies
  assert.equal(c.densityDelta, 0);
  assert.equal(c.activeTrackRatioDelta, 0);
  assert.equal(c.kind, "steady");
  assert.equal(c.basis, "energy");
});

test("empty → dense: energy rises, raw deltas stay exact", () => {
  const [c] = buildSectionContrasts(densityShapeSong([0, 16]));
  close(c.energyDelta?.value, 0.9468503937007874); // dense section energy − 0
  assert.equal(c.energyDelta?.confidence, 0.5);
  assert.equal(c.densityDelta, 16); // 16 onsets/bar − 0
  assert.equal(c.activeTrackRatioDelta, 1); // 0% → 100% of audible tracks
  assert.equal(c.kind, "rise");
  assert.equal(c.basis, "energy");
});

test("dense → empty: falls", () => {
  const [c] = buildSectionContrasts(densityShapeSong([16, 0]));
  assert.ok(c.energyDelta !== undefined && c.energyDelta.value < 0);
  assert.equal(c.densityDelta, -16);
  assert.equal(c.activeTrackRatioDelta, -1);
  assert.equal(c.kind, "fall");
  assert.equal(c.basis, "energy");
});

test("unanalyzed audio section: energyDelta stays undefined, density basis kicks in", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Keys", "midi", [
          midiClip("k", fourOnFloor(1), { start: 0, duration: 32 }),
        ]),
        track(1, "Pad", "audio", [audioClip("p", { start: 32, duration: 32 })]),
      ],
      { cuePoints: [{ time: 0, name: "A" }, { time: 32, name: "B" }] },
    ),
  );
  const features = buildMusicalFeatures(state);
  assert.equal(features.sections[1].energy, undefined); // precondition: B's energy unknown
  const [c] = buildSectionContrasts(features);
  // Never fabricated — and the fallback is declared, not silent.
  assert.equal(c.energyDelta, undefined);
  assert.equal(c.basis, "density");
  assert.equal(c.densityDelta, -4); // 4 onsets/bar → 0
  assert.equal(c.activeTrackRatioDelta, 0); // Keys in A, Pad in B: 1/2 each
  assert.equal(c.kind, "fall"); // normRange: 0 − 0.25 = −0.25 < −CONTRAST_EPS
});

test("two contrasts for three sections, in arrangement order", () => {
  const contrasts = buildSectionContrasts(densityShapeSong([1, 16, 1]));
  assert.equal(contrasts.length, 2);
  assert.deepEqual(
    contrasts.map((c) => [c.fromSectionId, c.toSectionId, c.kind]),
    [
      ["0", "1", "rise"],
      ["1", "2", "fall"],
    ],
  );
});
