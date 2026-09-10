/**
 * suggest.test.ts — the refine hint table: every metric/direction maps to a
 * concrete, deterministic prompt adjustment; unknown input degrades to a
 * generic line, never an exception.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { REFINE_DISCIPLINE, suggestForGenGap } from "../suggest.js";

test("crest gap suggests transients up / softening down", () => {
  assert.match(suggestForGenGap({ metric: "crestDb", direction: "up" }), /punchy, hard-hitting/);
  assert.match(suggestForGenGap({ metric: "crestDb", direction: "down" }), /soft, smooth/);
});

test("brightness gap suggests bright up / warm down", () => {
  assert.match(suggestForGenGap({ metric: "spectralCentroidHz", direction: "up" }), /bright, crisp/);
  assert.match(suggestForGenGap({ metric: "spectralCentroidHz", direction: "down" }), /warm, dark/);
});

test("band gaps name the band and its keywords", () => {
  assert.match(suggestForGenGap({ metric: "band", band: "sub", direction: "up" }), /sub/);
  assert.match(suggestForGenGap({ metric: "band", band: "sub", direction: "up" }), /808/);
  assert.match(suggestForGenGap({ metric: "band", band: "high", direction: "down" }), /high/);
});

test("every scalar metric yields a non-empty hint in both directions", () => {
  for (const metric of ["rmsDb", "peakDb", "crestDb", "loudnessDb", "dynamicRangeDb", "spectralCentroidHz", "transientDensity"] as const) {
    for (const direction of ["up", "down"] as const) {
      const hint = suggestForGenGap({ metric, direction });
      assert.ok(hint.length > 10, `${metric}/${direction}`);
      assert.match(hint, new RegExp(metric));
    }
  }
});

test("hints are deterministic", () => {
  const a = suggestForGenGap({ metric: "band", band: "lowMid", direction: "up" });
  const b = suggestForGenGap({ metric: "band", band: "lowMid", direction: "up" });
  assert.equal(a, b);
});

test("discipline line exists and mentions one-change-per-round", () => {
  assert.match(REFINE_DISCIPLINE, /一个主要方向/);
});
