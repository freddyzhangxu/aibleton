/**
 * gap.test.ts — delta semantics, epsilon, unknown-safety, confidence
 * weakest-link, strength anchors, section_contrast, verification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveReferenceGaps,
  verifyReferenceProgress,
  REFERENCE_GAP_EPSILON,
  REFERENCE_GAP_REDUCTION_EPSILON,
} from "../gap.js";
import { curSection, fv, refSection } from "./fixtures.js";
import type { ReferencePlanningContext } from "../types.js";

const gap = (metric: string, gaps: ReturnType<typeof deriveReferenceGaps>) =>
  gaps.find((g) => g.metric === metric);

test("positive delta → higher_in_reference; strength and delta anchored", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  const gaps = deriveReferenceGaps(cur, ref);
  const g = gap("energy", gaps);
  assert.ok(g !== undefined);
  assert.equal(g.direction, "higher_in_reference");
  assert.equal(g.delta, 0.22);
  // strength = |delta| / 0.4 → 0.55
  assert.equal(g.strength, 0.55);
});

test("negative delta → lower_in_reference", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.85) });
  const ref = refSection(1, { features: { energy: fv(0.6) } });
  const g = gap("energy", deriveReferenceGaps(cur, ref));
  assert.equal(g?.direction, "lower_in_reference");
  assert.equal(g?.delta, -0.25);
});

test("epsilon: differences below REFERENCE_GAP_EPSILON read similar", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.8) });
  const ref = refSection(1, { features: { energy: fv(0.8 + REFERENCE_GAP_EPSILON - 0.03) } });
  const g = gap("energy", deriveReferenceGaps(cur, ref));
  assert.equal(g?.direction, "similar");
});

test("strength saturates at 1.0 for |delta| ≥ 0.4", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.1) });
  const ref = refSection(1, { features: { energy: fv(0.95) } });
  assert.equal(gap("energy", deriveReferenceGaps(cur, ref))?.strength, 1);
});

test("unknown on EITHER side → no gap at all (never reference − 0)", () => {
  const cur = curSection("3", "Drop 2"); // energy undefined
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  assert.equal(gap("energy", deriveReferenceGaps(cur, ref)), undefined);
  // ...and the reverse.
  const cur2 = curSection("3", "Drop 2", { energy: fv(0.5) });
  const ref2 = refSection(1, { features: {} });
  assert.equal(gap("energy", deriveReferenceGaps(cur2, ref2)), undefined);
});

test("audio-only reference never invents variation/repetition/active_track_ratio gaps", () => {
  const cur = curSection("3", "Drop 2", { variation: 0.4, repetition: 0.6, activeTrackRatio: 0.8 });
  const ref = refSection(1, { features: {} });
  const gaps = deriveReferenceGaps(cur, ref);
  assert.equal(gap("variation", gaps), undefined);
  assert.equal(gap("repetition", gaps), undefined);
  assert.equal(gap("active_track_ratio", gaps), undefined);
});

test("confidence is the weakest link of current, reference and alignment", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6, 0.9) });
  const ref = refSection(1, { features: { energy: fv(0.82, 0.7) } });
  const g = gap("energy", deriveReferenceGaps(cur, ref, { alignmentConfidence: 0.8 }));
  assert.equal(g?.confidence, 0.7);
});

test("MIDI facts carry no confidence — and none is fabricated", () => {
  const cur = curSection("3", "Drop 2", { density: 2 });
  const ref = refSection(1, { features: {} });
  // Reference density needs a tempo-derived feature; give it one.
  const ref2 = refSection(1, { features: { density: fv(5, 0.9) } });
  const g = gap("density", deriveReferenceGaps(cur, ref2));
  assert.equal(g?.confidence, 0.9); // reference side only; current is a raw fact
  assert.equal(g?.current?.source, "midi"); // provenance echoed, not laundered
  void ref;
});

test("section_contrast compares each section against its own predecessor", () => {
  const prev = curSection("2", "Build 2", { energy: fv(0.5) });
  const cur = curSection("3", "Drop 2", { energy: fv(0.8) }); // contrast 0.3
  const refPrev = refSection(0, { features: { energy: fv(0.5) } });
  const ref = refSection(1, { features: { energy: fv(0.95) } }); // contrast 0.45
  const g = gap(
    "section_contrast",
    deriveReferenceGaps(cur, ref, { currentPrev: prev, referencePrev: refPrev }),
  );
  assert.ok(g !== undefined);
  assert.equal(g.direction, "higher_in_reference");
  assert.ok(Math.abs((g.delta ?? 0) - 0.15) < 1e-9);
  // Without BOTH predecessors the metric is silent.
  assert.equal(gap("section_contrast", deriveReferenceGaps(cur, ref)), undefined);
});

test("emission order and content are deterministic", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6), density: 2 });
  const ref = refSection(1, { features: { energy: fv(0.82), density: fv(5) } });
  const a = deriveReferenceGaps(cur, ref, { alignmentConfidence: 0.8 });
  const b = deriveReferenceGaps(cur, ref, { alignmentConfidence: 0.8 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// verifyReferenceProgress
// ---------------------------------------------------------------------------

function ctx(gaps: ReturnType<typeof deriveReferenceGaps>): ReferencePlanningContext {
  return {
    currentSectionId: "3",
    referenceSectionId: "reference:section:1",
    comparison: [],
    gaps,
    actions: [],
    coverage: 0.5,
  };
}

test("gap reduction: 0.21 → 0.08 is satisfied; 0.21 → 0.20 is not", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.61) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  const before = ctx(deriveReferenceGaps(cur, ref));

  const afterGood = curSection("3", "Drop 2", { energy: fv(0.74) });
  const good = verifyReferenceProgress(before, ctx(deriveReferenceGaps(afterGood, ref)));
  assert.equal(good.length, 1);
  assert.equal(good[0].beforeGap, 0.21);
  assert.equal(good[0].afterGap, 0.08);
  assert.equal(good[0].gapReduction, 0.13);
  assert.equal(good[0].satisfied, true);

  const afterBarely = curSection("3", "Drop 2", { energy: fv(0.62) });
  const barely = verifyReferenceProgress(before, ctx(deriveReferenceGaps(afterBarely, ref)));
  assert.ok(Math.abs((barely[0].gapReduction ?? 0) - 0.01) < 1e-9);
  assert.equal(barely[0].satisfied, false);
  assert.ok(REFERENCE_GAP_REDUCTION_EPSILON > 0.01);
});

test("after-gap larger than before → negative reduction, unsatisfied", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.61) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  const before = ctx(deriveReferenceGaps(cur, ref));
  const worse = curSection("3", "Drop 2", { energy: fv(0.4) });
  const [v] = verifyReferenceProgress(before, ctx(deriveReferenceGaps(worse, ref)));
  assert.ok((v.gapReduction ?? 0) < 0);
  assert.equal(v.satisfied, false);
});

test("unmeasurable after-side → unknown, never a fabricated pass", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.61) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  const before = ctx(deriveReferenceGaps(cur, ref));
  const afterUnknown = curSection("3", "Drop 2"); // energy undefined after
  const [v] = verifyReferenceProgress(before, ctx(deriveReferenceGaps(afterUnknown, ref)));
  assert.equal(v.afterGap, undefined);
  assert.equal(v.gapReduction, undefined);
  assert.equal(v.satisfied, undefined);
});
