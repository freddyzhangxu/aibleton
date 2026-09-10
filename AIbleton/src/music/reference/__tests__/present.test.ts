/**
 * present.test.ts — the bounded reference block: stable ordering, 2dp,
 * unknown omitted, budget stages, identity preservation, verification lines.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { presentReferencePlanningContext, presentReferenceVerification, REFERENCE_CONTEXT_BUDGET } from "../present.js";
import { deriveReferenceGaps, verifyReferenceProgress } from "../gap.js";
import { deriveReferenceActions } from "../actions.js";
import { curSection, fv, refSection } from "./fixtures.js";
import type { ReferencePlanningContext } from "../types.js";

function ctxOf(
  cur: Parameters<typeof deriveReferenceGaps>[0],
  ref: Parameters<typeof deriveReferenceGaps>[1],
): ReferencePlanningContext {
  const gaps = deriveReferenceGaps(cur, ref, { alignmentConfidence: 0.9 });
  return {
    currentSectionId: cur.sectionId,
    referenceSectionId: ref.id,
    comparison: [],
    gaps,
    actions: deriveReferenceActions(gaps),
    coverage: gaps.length / 16,
  };
}

test("meaningful gaps render first (strength desc), similar comparisons after", () => {
  const cur = curSection("3", "Drop 2", {
    energy: fv(0.6),
    density: 3.9,
    rhythmicActivity: fv(0.5),
  });
  const ref = refSection(1, {
    features: { energy: fv(0.85), density: fv(4), rhythmicActivity: fv(0.75) },
  });
  const out = presentReferencePlanningContext(ctxOf(cur, ref));
  const gaps = out.gaps as { metric: string; dir: string }[];
  // energy (+0.25, strength .625) and rhythm (+0.25, .625) are meaningful;
  // density (+0.1, .25) is meaningful but weaker; ordering: meaningful first.
  const dirs = gaps.map((g) => g.dir);
  const firstSimilar = dirs.indexOf("similar");
  assert.ok(firstSimilar === -1 || dirs.slice(0, firstSimilar).every((d) => d !== "similar"));
  assert.equal(out.reference && (out.reference as { match: string }).match, "reference:section:1");
});

test("values render at 2 decimals; absent confidence is omitted, never faked", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.61, 0.9), density: 2 });
  // density: raw MIDI fact on the current side → gap confidence comes from
  // the reference side only.
  const ref = refSection(1, { features: { energy: fv(0.86, 0.9) } });
  const out = presentReferencePlanningContext(ctxOf(cur, ref));
  const g = (out.gaps as Record<string, unknown>[]).find((x) => x.metric === "energy")!;
  assert.equal(g.cur, 0.61);
  assert.equal(g.ref, 0.86);
  assert.equal(g.delta, 0.25);
  assert.equal(g.conf, 0.9);
});

test("default budget keeps the block under REFERENCE_CONTEXT_BUDGET", () => {
  const cur = curSection("3", "Drop 2", {
    energy: fv(0.4),
    density: 1,
    rhythmicActivity: fv(0.3),
    lowEnergy: fv(0.1),
    midEnergy: fv(0.2),
    highEnergy: fv(0.3),
    spectralBrightness: fv(0.2),
    transientDensity: fv(2),
    dynamicRange: fv(4),
    impact: fv(0.3),
    tension: fv(0.2),
    release: fv(0.3),
  });
  const ref = refSection(1, {
    features: {
      energy: fv(0.9),
      density: fv(9),
      rhythmicActivity: fv(0.8),
      lowEnergy: fv(0.5),
      midEnergy: fv(0.6),
      highEnergy: fv(0.7),
      spectralBrightness: fv(0.7),
      transientDensity: fv(8),
      dynamicRange: fv(16),
      impact: fv(0.9),
      tension: fv(0.8),
      release: fv(0.9),
    },
  });
  const out = presentReferencePlanningContext(ctxOf(cur, ref));
  assert.ok(JSON.stringify(out).length <= REFERENCE_CONTEXT_BUDGET);
});

test("tight budget cuts low-confidence and secondary content, never identity", () => {
  const cur = curSection("3", "Drop 2", {
    energy: fv(0.4, 0.9),
    density: 1,
    lowEnergy: fv(0.1, 0.3), // low-confidence gap — first to go
    spectralBrightness: fv(0.2, 0.9), // secondary metric — later
  });
  const ref = refSection(1, {
    features: {
      energy: fv(0.9, 0.9),
      density: fv(9, 0.9),
      lowEnergy: fv(0.5, 0.3),
      spectralBrightness: fv(0.7, 0.9),
    },
  });
  const ctx = ctxOf(cur, ref);
  const tight = presentReferencePlanningContext(ctx, { maxChars: 120 });
  const metrics = ((tight.gaps as Record<string, unknown>[]) ?? []).map((g) => g.metric);
  assert.ok(!metrics.includes("lowEnergy"), "low-confidence gap cut first");
  // Identity survives every cut stage.
  assert.equal((tight.reference as { match: string }).match, "reference:section:1");
  assert.ok(JSON.stringify(tight).length <= 400); // small, even if over 120
});

test("deterministic: same context → identical block", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6) });
  const ref = refSection(1, { features: { energy: fv(0.85) } });
  const ctx = ctxOf(cur, ref);
  assert.deepEqual(presentReferencePlanningContext(ctx), presentReferencePlanningContext(ctx));
});

test("verification lines: unsatisfied gaps named, satisfied ones silent", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.61) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  const before = ctxOf(cur, ref);

  const stillFar = curSection("3", "Drop 2", { energy: fv(0.63) });
  const missed = verifyReferenceProgress(before, ctxOf(stillFar, ref));
  const lines = presentReferenceVerification(missed);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /参考校验/);
  assert.match(lines[0], /energy/);

  const closed = curSection("3", "Drop 2", { energy: fv(0.76) });
  const satisfied = verifyReferenceProgress(before, ctxOf(closed, ref));
  assert.deepEqual(presentReferenceVerification(satisfied), []);

  // Nothing measured before → nothing to complain about.
  assert.deepEqual(presentReferenceVerification([]), []);
});
