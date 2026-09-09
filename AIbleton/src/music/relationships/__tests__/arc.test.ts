import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildArrangementArc } from "../arc.js";
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

// Section energies with the fixture's constant velocity/track layout:
// E(density 1) = 0.5·(1/16) + 0.25 + 0.25·(100/127) ≈ 0.4781
// E(density 4) ≈ 0.5719, E(density 16) ≈ 0.9469.

test("energyCurve projects sections[].energy verbatim", () => {
  const arc = buildArrangementArc(densityShapeSong([1, 16]));
  assert.equal(arc.energyCurve.length, 2);
  close(arc.energyCurve[0], 0.4781003937007874);
  close(arc.energyCurve[1], 0.9468503937007874);
  assert.equal(arc.energyCoverage, 1);
});

test("monotonic rise → build, peak at the last section", () => {
  const arc = buildArrangementArc(densityShapeSong([1, 4, 16]));
  assert.equal(arc.kind, "build");
  assert.equal(arc.peakSectionId, "2");
  close(arc.peakPosition, 80 / 96);
});

test("monotonic fall → breakdown, peak at the first section", () => {
  const arc = buildArrangementArc(densityShapeSong([16, 4, 1]));
  assert.equal(arc.kind, "breakdown");
  assert.equal(arc.peakSectionId, "0");
  close(arc.peakPosition, 16 / 96);
});

test("low–high–low → arch, peak in the middle", () => {
  const arc = buildArrangementArc(densityShapeSong([1, 16, 1]));
  assert.equal(arc.kind, "arch");
  assert.equal(arc.peakSectionId, "1");
  close(arc.peakPosition, 0.5);
});

test("high–low–high → valley, peak ties resolve to the earliest section", () => {
  const arc = buildArrangementArc(densityShapeSong([16, 1, 16]));
  assert.equal(arc.kind, "valley");
  assert.equal(arc.peakSectionId, "0");
});

test("identical energies → flat", () => {
  const arc = buildArrangementArc(densityShapeSong([4, 4]));
  assert.equal(arc.kind, "flat");
  assert.equal(arc.peakSectionId, "0");
});

test("zigzag → irregular (honest none-of-the-above)", () => {
  const arc = buildArrangementArc(densityShapeSong([1, 16, 1, 16]));
  assert.equal(arc.kind, "irregular");
  assert.equal(arc.peakSectionId, "1");
  close(arc.peakPosition, 48 / 128);
});

test("single section: kind undefined, peak still reported", () => {
  const arc = buildArrangementArc(densityShapeSong([4]));
  assert.equal(arc.kind, undefined);
  assert.equal(arc.peakSectionId, "0");
  assert.equal(arc.energyCoverage, 1);
  close(arc.peakPosition, 0.5);
});

test("unanalyzed audio gap: skipped on the curve, visible in coverage", () => {
  const state = buildMusicState(
    snapshot(
      [
        track(0, "Keys", "midi", [
          midiClip("k1", fourOnFloor(1), { start: 0, duration: 32 }),
          midiClip("k2", fourOnFloor(1), { start: 64, duration: 32 }),
        ]),
        track(1, "Pad", "audio", [audioClip("p", { start: 32, duration: 32 })]),
      ],
      {
        cuePoints: [
          { time: 0, name: "A" },
          { time: 32, name: "B" },
          { time: 64, name: "C" },
        ],
      },
    ),
  );
  const arc = buildArrangementArc(buildMusicalFeatures(state));
  assert.equal(arc.energyCurve.length, 3);
  assert.equal(arc.energyCurve[1], undefined); // honesty: B's energy unknown
  // A's energy: the UNMUTED Pad counts in the audible-tracks denominator,
  // so activeTrackRatio = 1/2 → 0.5·(4/16) + 0.25·0.5 + 0.25·(100/127).
  close(arc.energyCurve[0], 0.4468503937007874);
  close(arc.energyCoverage, 2 / 3);
  assert.equal(arc.kind, "flat"); // classified on the two known values
  assert.equal(arc.peakSectionId, "0");
});
