/**
 * context.test.ts — buildSectionPlanningContext + presentSectionPlanningContext:
 * target-centric filtering, goal-relevant feature projection, action
 * filtering, budget behavior, and stable serialization.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSectionPlanningContext, presentSectionPlanningContext, SECTION_CONTEXT_BUDGET } from "../context.js";
import { goalOf, sevenSectionIntel } from "./fixtures.js";

const GOAL = goalOf({
  target: { section: "second drop" },
  objective: "make the second drop evolve from the first",
  successCriteria: [],
});

test("builder: resolves target, keeps references and in-scope rows", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  assert.equal(ctx.target.sectionId, "5");
  assert.equal(ctx.target.name, "Drop 2");
  assert.ok(ctx.references.some((r) => r.name === "Drop 1"));
  assert.equal(ctx.targetFeatures.sectionId, "5");
  assert.equal(ctx.song.sectionCount, 7);
  assert.equal(ctx.song.tempo, 128);
});

test("builder: unmatched target yields undefined (song-level fallback)", () => {
  const intel = sevenSectionIntel();
  assert.equal(buildSectionPlanningContext(goalOf({ target: { section: "chorus" } }), intel), undefined);
  assert.equal(buildSectionPlanningContext(goalOf({}), intel), undefined);
});

test("observations: target/reference ones in, unrelated ones out", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  const kinds = ctx.observations.map((o) => o.kind);
  assert.ok(kinds.includes("section_reprise"));
  assert.ok(kinds.includes("repeated_section_low_variation"));
  assert.ok(!kinds.includes("energy_increase"), "Intro-only observation must be filtered out");
  // Ranked: strength × confidence — low_variation (0.7×1) above reprise
  // (0.8×0.85 = 0.68).
  assert.equal(ctx.observations[0].kind, "repeated_section_low_variation");
});

test("actions: target first, song-scope fills, unrelated track action out", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  const kinds = ctx.actions.map((a) => a.kind);
  assert.equal(kinds[0], "introduce_variation"); // target action, layer's rank order
  assert.ok(kinds.includes("develop_section"));
  assert.ok(kinds.includes("increase_energy"), "song-scope action rides along");
  assert.ok(!kinds.includes("remove_layer"), "track-scoped unrelated action must be filtered out");
  assert.ok(ctx.actions.length <= 5);
});

test("features: variation projected for variation goals; audio fields absent without energy criteria", () => {
  const intel = sevenSectionIntel({ variation: { "5": 0.18 }, repetition: { "5": 0.82 } });
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  assert.equal(ctx.features.variation, 0.18);
  assert.equal(ctx.features.repetition, 0.82);
  assert.equal(ctx.features.density, 4);
  assert.ok(ctx.features.energy);
  assert.equal(ctx.features.lowEnergy, undefined); // no audio data AND not goal-relevant
  assert.equal(ctx.features.impact, undefined);
});

test("features: extended energy fields join when an energy criterion exists", () => {
  const intel = sevenSectionIntel();
  const s5 = intel.features.sections.find((s) => s.sectionId === "5");
  assert.ok(s5);
  s5.impact = { value: 0.66, source: "derived", confidence: 0.8 };
  const ctx = buildSectionPlanningContext(
    goalOf({
      target: { section: "Drop 2" },
      successCriteria: [{ kind: "section_energy_gt", a: "Drop 2", b: "baseline:Drop 2" }],
    }),
    intel,
  );
  assert.ok(ctx);
  assert.equal(ctx.features.impact?.value, 0.66);
});

test("coverage reports what the planner can read", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  assert.equal(ctx.coverage.observationCount, ctx.observations.length);
  assert.equal(ctx.coverage.actionCount, ctx.actions.length);
  assert.ok(ctx.coverage.featureCoverage > 0 && ctx.coverage.featureCoverage <= 1);
});

test("present: compact JSON, 2dp, unknown omitted, budget respected", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  const out = presentSectionPlanningContext(ctx);
  assert.ok(JSON.stringify(out).length <= SECTION_CONTEXT_BUDGET);
  const target = out.target as Record<string, unknown>;
  assert.equal(target.id, "5");
  assert.equal(target.name, "Drop 2");
  assert.deepEqual(target.beats, [160, 192]);
  const refs = out.references as Record<string, unknown>[];
  assert.ok(refs.some((r) => r.name === "Drop 1" && r.sim === 0.91));
  // No prose, no full MusicState dump: the block is the bounded selection.
  assert.ok(!("tracks" in out));
});

test("present: tiny budget still returns a complete structure with the target", () => {
  const intel = sevenSectionIntel();
  const ctx = buildSectionPlanningContext(GOAL, intel);
  assert.ok(ctx);
  const out = presentSectionPlanningContext(ctx, { maxChars: 10 });
  const target = out.target as Record<string, unknown>;
  assert.equal(target.id, "5"); // identity is never cut
  assert.ok(Array.isArray(target.beats));
});

test("determinism: identical inputs → identical context and serialization", () => {
  const intel = sevenSectionIntel();
  const a = buildSectionPlanningContext(GOAL, intel);
  const b = buildSectionPlanningContext(GOAL, sevenSectionIntel());
  assert.deepEqual(a, b);
  assert.ok(a && b);
  assert.equal(JSON.stringify(presentSectionPlanningContext(a)), JSON.stringify(presentSectionPlanningContext(b)));
});
