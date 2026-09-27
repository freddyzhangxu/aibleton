import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFeatures } from "../../dsp.js";
import { compareVocalFeatures } from "./compare.js";

function features(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    durationSec: 10,
    sampleRate: 44100,
    channels: 1,
    rmsDb: -20,
    peakDb: -3,
    crestDb: 17,
    truePeakDb: -2.8,
    loudnessDb: -21,
    spectralCentroidHz: 2200,
    bands: { sub: 0.01, bass: 0.04, lowMid: 0.2, mid: 0.35, highMid: 0.25, high: 0.15 },
    ...overrides,
  };
}

test("reports measured source deltas as recorded minus reference", () => {
  const result = compareVocalFeatures(
    features({ rmsDb: -20, spectralCentroidHz: 2200 }),
    features({ rmsDb: -23, spectralCentroidHz: 2000 }),
  );
  assert.deepEqual(result.deltas, [
    { metric: "rms", recorded: -20, reference: -23, delta: 3, unit: "dB" },
    { metric: "spectral_centroid", recorded: 2200, reference: 2000, delta: 200, unit: "Hz" },
  ]);
  assert.equal(result.recorded.rmsDb, -20);
  assert.equal(result.reference.rmsDb, -23);
});

test("omits unavailable metrics and never presents candidate cues as pitch diagnosis", () => {
  const result = compareVocalFeatures(
    features({ dynamicRangeDb: undefined, vocalCues: { nearFullScalePercent: 0.1, activeRangeDb: 12 } }),
    features({ dynamicRangeDb: 8, vocalCues: { nearFullScalePercent: 0.3 } }),
  );
  assert.ok(!result.deltas.some((d) => d.metric === "dynamic_range"));
  assert.ok(!result.cueDeltas.some((d) => d.metric === "active_range"));
  assert.deepEqual(result.cueDeltas, [
    { metric: "near_full_scale_share", recorded: 0.1, reference: 0.3, delta: -0.2, unit: "%", kind: "candidate" },
  ]);
  assert.match(result.caveat, /screening|candidate/i);
  assert.match(result.caveat, /pitch|tune/i);
});
