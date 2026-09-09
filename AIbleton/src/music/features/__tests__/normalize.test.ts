import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clamp01,
  fv,
  normLog,
  normOpt,
  normRange,
  weightedMean,
} from "../normalize.js";

test("clamp01 bounds", () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(7), 1);
});

test("normRange anchors and clamping", () => {
  assert.equal(normRange(-1, 0, 16), 0); // below lo
  assert.equal(normRange(8, 0, 16), 0.5); // midpoint
  assert.equal(normRange(99, 0, 16), 1); // above hi
  assert.equal(normRange(5, 10, 10), 0); // degenerate range
});

test("normOpt propagates undefined instead of inventing a number", () => {
  assert.equal(normOpt(undefined, 0, 16), undefined);
  assert.equal(normOpt(4, 0, 16), 0.25);
});

test("normLog is log-scaled between the anchors", () => {
  assert.equal(normLog(200, 200, 8000), 0);
  assert.equal(normLog(8000, 200, 8000), 1);
  // Geometric midpoint lands at 0.5 on a log scale.
  const mid = Math.sqrt(200 * 8000);
  assert.ok(Math.abs(normLog(mid, 200, 8000) - 0.5) < 1e-9);
  assert.equal(normLog(0, 200, 8000), 0); // non-positive clamps to bottom
});

test("fv omits confidence when not given", () => {
  assert.deepEqual(fv(0.5, "midi"), { value: 0.5, source: "midi" });
  assert.deepEqual(fv(0.5, "derived", 0.75), {
    value: 0.5,
    source: "derived",
    confidence: 0.75,
  });
});

test("weightedMean: full data → weighted value, coverage 1", () => {
  const r = weightedMean([
    { v: 1, w: 0.25 },
    { v: 0.5, w: 0.75 },
  ]);
  assert.ok(r);
  assert.ok(Math.abs(r.value - (1 * 0.25 + 0.5 * 0.75)) < 1e-12);
  assert.equal(r.coverage, 1);
});

test("weightedMean: missing inputs renormalize and shrink coverage", () => {
  const r = weightedMean([
    { v: 0.8, w: 0.25 },
    { v: undefined, w: 0.75 },
  ]);
  assert.ok(r);
  assert.equal(r.value, 0.8); // only the present component counts
  assert.equal(r.coverage, 0.25);
});

test("weightedMean: no data at all → undefined, never a fake 0", () => {
  assert.equal(
    weightedMean([
      { v: undefined, w: 1 },
      { v: undefined, w: 2 },
    ]),
    undefined,
  );
});
