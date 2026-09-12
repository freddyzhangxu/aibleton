import { test } from "node:test";
import assert from "node:assert/strict";
import { diffGenerations, GENERATION_DIFF_METRICS } from "../diff.js";
import type { GenerationRecord } from "../types.js";
import type { AudioFeatures } from "../../dsp.js";

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    durationSec: 8,
    sampleRate: 44100,
    channels: 2,
    rmsDb: -18,
    peakDb: -3,
    crestDb: 15,
    loudnessDb: -20,
    dynamicRangeDb: 9,
    spectralCentroidHz: 2500,
    bands: { sub: 0.1, bass: 0.2, lowMid: 0.2, mid: 0.2, highMid: 0.2, high: 0.1 },
    transientDensity: 4,
    ...over,
  };
}

function record(id: string, f?: AudioFeatures, featuresError?: string): GenerationRecord {
  return {
    id,
    file: `/tmp/${id}.wav`,
    provider: "stable-audio",
    prompt: "p",
    params: { seconds: 8 },
    createdAt: "2026-09-10T00:00:00.000Z",
    ...(f ? { features: f } : {}),
    ...(featuresError ? { featuresError } : {}),
  };
}

test("metric vocabulary covers scalars and all six bands", () => {
  assert.equal(GENERATION_DIFF_METRICS.length, 13);
  assert.ok(GENERATION_DIFF_METRICS.includes("crestDb"));
  assert.ok(GENERATION_DIFF_METRICS.includes("band_highMid"));
});

test("delta is after − before, per metric and per band", () => {
  const d = diffGenerations(record("a", features()), record("b", features({ crestDb: 18 })));
  assert.deepEqual(d.metrics.crestDb, { before: 15, after: 18, delta: 3 });
  assert.equal(d.metrics.rmsDb?.delta, 0);
  assert.equal(d.metrics.band_sub?.delta, 0);
});

test("a metric missing on either side produces no entry (unknown ≠ zero)", () => {
  const noDyn = features({ dynamicRangeDb: undefined });
  const d = diffGenerations(record("a", noDyn), record("b", features()));
  assert.equal(d.metrics.dynamicRangeDb, undefined);
  assert.ok(d.metrics.crestDb); // unaffected metrics still diff
});

test("a record without features yields an empty metrics map", () => {
  const d = diffGenerations(record("a", undefined, "unsupported format \".mp3\""), record("b", features()));
  assert.deepEqual(d.metrics, {});
  assert.equal(d.from, "a");
  assert.equal(d.to, "b");
});
