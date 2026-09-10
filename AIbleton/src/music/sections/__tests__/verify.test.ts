/**
 * verify.test.ts — goal-aware section verification: thresholds, unknown-safe
 * semantics, maintain direction, target re-matching, relative (contrast /
 * similarity) verdicts, and criteria projection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSectionPlanningContext } from "../context.js";
import { projectSectionVerificationCriteria, verifySectionChange, SECTION_DELTA_THRESHOLDS } from "../verify.js";
import { goalOf, sevenSectionIntel, type FixtureSpec } from "./fixtures.js";

const ENERGY_GOAL = goalOf({
  target: { section: "Drop 2" },
  successCriteria: [{ kind: "section_energy_gt", a: "Drop 2", b: "baseline:Drop 2" }],
});

function ctxPair(beforeSpec: FixtureSpec, afterSpec: FixtureSpec, goal = ENERGY_GOAL) {
  const beforeIntel = sevenSectionIntel(beforeSpec);
  const afterIntel = sevenSectionIntel(afterSpec);
  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx, "before context must resolve");
  return { ctx, beforeIntel, afterIntel };
}

function criterion(ver: ReturnType<typeof verifySectionChange>, metric: string) {
  const c = ver.criteria.find((x) => x.metric === metric);
  assert.ok(c, `criterion ${metric} must exist`);
  return c;
}

test("energy increase: sufficient delta passes", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "5": 0.5 } }, { energy: { "5": 0.65 } });
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  assert.equal(ver.status, "passed");
  const e = criterion(ver, "energy");
  assert.equal(e.status, "passed");
  assert.equal(e.before, 0.5);
  assert.equal(e.after, 0.65);
  assert.ok(e.delta !== undefined && Math.abs(e.delta - 0.15) < 1e-9);
});

test("energy increase: sub-threshold delta fails (noise is not a change)", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "5": 0.5 } }, { energy: { "5": 0.51 } });
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  assert.equal(ver.status, "failed");
  assert.equal(criterion(ver, "energy").status, "failed");
  assert.equal(SECTION_DELTA_THRESHOLDS.energy, 0.03);
});

test("energy decrease goal: baseline:X > X judges a DROP", () => {
  const calmGoal = goalOf({
    target: { section: "Breakdown" },
    successCriteria: [{ kind: "section_energy_gt", a: "baseline:Breakdown", b: "Breakdown" }],
  });
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "3": 0.6 } }, { energy: { "3": 0.45 } }, calmGoal);
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, calmGoal);
  assert.equal(ver.status, "passed");
  const e = criterion(ver, "energy");
  assert.equal(e.direction, "decrease");
  assert.equal(e.status, "passed");
});

test("variation increase via creative actions passes (acceptance scenario)", () => {
  const evolveGoal = goalOf({
    target: { section: "second drop" },
    objective: "make the second drop evolve from the first",
    successCriteria: [{ kind: "tempo_unchanged" }],
  });
  const spec = (variation: number, similarity: number): FixtureSpec => ({
    variation: { "5": variation },
    similarities: [
      { aSectionId: "2", bSectionId: "5", similarity: { value: similarity, source: "derived", confidence: 0.85 }, kind: "repeat" },
    ],
    // Only the variation actions — the acceptance scenario's action set.
    actions: [
      {
        kind: "introduce_variation",
        target: { sectionId: "5", relatedSectionId: "2", scope: "section" },
        strength: 0.8,
        dimension: "variation",
        sourceObservations: [],
      },
      {
        kind: "develop_section",
        target: { sectionId: "5", relatedSectionId: "2", scope: "section" },
        strength: 0.7,
        dimension: "variation",
        sourceObservations: [],
      },
    ],
  });
  const { ctx, beforeIntel, afterIntel } = ctxPair(spec(0.18, 0.91), spec(0.37, 0.78), evolveGoal);
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, evolveGoal);
  assert.equal(ver.status, "passed");
  assert.equal(criterion(ver, "variation").status, "passed");
  assert.equal(criterion(ver, "similarity").status, "passed");
  // Relationship evidence rides along even beyond the judged criteria.
  const sim = ver.relationshipChanges.find((r) => r.metric === "similarity" && r.referenceSectionId === "2");
  assert.ok(sim);
  assert.equal(sim.before, 0.91);
  assert.equal(sim.after, 0.78);
});

test("maintain: within threshold passes, beyond fails", () => {
  const keepGoal = goalOf({
    target: { section: "Drop 2" },
    successCriteria: [{ kind: "section_tracks_gte", section: "Drop 2", n: "baseline" }],
  });
  const pass = ctxPair({}, {}, keepGoal); // activeTrackRatio 0.6 → 0.6
  const verPass = verifySectionChange(pass.ctx, pass.beforeIntel, pass.afterIntel, keepGoal);
  assert.equal(criterion(verPass, "active_track_ratio").status, "passed");

  const beforeIntel = sevenSectionIntel();
  const afterIntel = sevenSectionIntel();
  const after5 = afterIntel.features.sections.find((s) => s.sectionId === "5");
  assert.ok(after5);
  after5.activeTrackRatio = 0.4; // layers stripped
  const ctx = buildSectionPlanningContext(keepGoal, beforeIntel);
  assert.ok(ctx);
  const verFail = verifySectionChange(ctx, beforeIntel, afterIntel, keepGoal);
  assert.equal(criterion(verFail, "active_track_ratio").status, "failed");
  assert.equal(verFail.status, "failed");
});

test("unknown before/after is unknown — never failed, never 0", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "5": undefined } }, { energy: { "5": 0.5 } });
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  const e = criterion(ver, "energy");
  assert.equal(e.status, "unknown");
  assert.equal(e.before, undefined);
  assert.equal(ver.status, "unknown"); // unknown ≠ passed
});

test("target lost after execution: matchedAfter false, verdict unknown", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({}, {});
  afterIntel.features.sections = afterIntel.features.sections.filter((s) => s.sectionId !== "5");
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  assert.equal(ver.matchedAfter, false);
  assert.equal(ver.status, "unknown");
  assert.equal(ver.target.afterSectionId, undefined);
  assert.ok(ver.criteria.every((c) => c.status === "unknown"));
});

test("relative goal: Build→Drop contrast must grow, not just Drop energy", () => {
  const harderGoal = goalOf({
    target: { section: "Drop 2" },
    successCriteria: [{ kind: "section_energy_gt", a: "Drop 2", b: "Build 2" }],
  });
  const criteria = projectSectionVerificationCriteria(
    harderGoal,
    [],
    // minimal target stand-in matching the resolved shape
    { sectionId: "5", name: "Drop 2", startBeat: 160, endBeat: 192, match: "label", confidence: 1 },
    [{ sectionId: "4", name: "Build 2", reason: "contrast", relevance: 0.92 }],
  );
  assert.ok(criteria.some((c) => c.metric === "energy" && c.direction === "increase" && c.required));
  assert.ok(
    criteria.some((c) => c.metric === "contrast" && c.direction === "increase" && c.required && c.referenceSectionId === "4"),
  );

  // Contrast grows 0.08 → 0.20 while Drop 2's own energy also rises.
  const { ctx, beforeIntel, afterIntel } = ctxPair(
    { energy: { "4": 0.7, "5": 0.78 } },
    { energy: { "4": 0.62, "5": 0.82 } },
    harderGoal,
  );
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, harderGoal);
  const contrast = criterion(ver, "contrast");
  assert.ok(contrast.before !== undefined && Math.abs(contrast.before - 0.08) < 1e-9);
  assert.ok(contrast.after !== undefined && Math.abs(contrast.after - 0.2) < 1e-9);
  assert.equal(contrast.status, "passed");
  assert.equal(ver.status, "passed");
});

test("confidence is weakest-link across judged criteria", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "5": 0.5 } }, { energy: { "5": 0.65 } });
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  const e = criterion(ver, "energy");
  assert.equal(e.confidence, 0.9); // min(before, after) fixture confidences
  assert.equal(ver.confidence, 0.9);
});

test("criteria projection: goal criteria are required, actions only support", () => {
  const criteria = projectSectionVerificationCriteria(
    ENERGY_GOAL,
    [
      {
        kind: "decrease_energy",
        target: { sectionId: "5" },
        strength: 0.5,
        dimension: "energy",
        sourceObservations: [],
      },
    ],
    { sectionId: "5", name: "Drop 2", startBeat: 160, endBeat: 192, match: "label", confidence: 1 },
    [],
  );
  const required = criteria.filter((c) => c.required);
  assert.equal(required.length, 1);
  assert.equal(required[0].direction, "increase");
  // The contradictory action is recorded as supporting evidence, never gate.
  assert.ok(criteria.some((c) => !c.required && c.direction === "decrease"));
});

test("verification is deterministic", () => {
  const { ctx, beforeIntel, afterIntel } = ctxPair({ energy: { "5": 0.5 } }, { energy: { "5": 0.65 } });
  const a = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  const b = verifySectionChange(ctx, beforeIntel, afterIntel, ENERGY_GOAL);
  assert.deepEqual(a, b);
});
