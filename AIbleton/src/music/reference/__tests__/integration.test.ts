/**
 * integration.test.ts — the PR16 chain end to end over literal fixtures:
 *
 *   ReferenceAnalysis → ReferenceIntelligence → SectionPlanningContext
 *   → presentation → (mock state mutation) → re-derived gaps
 *   → verifyReferenceProgress → retry evidence
 *
 * Covers the §51 fixtures and the §54–§58 acceptance scenarios at the
 * intelligence level (the planner itself is the LLM — mocked here as "apply
 * the suggested direction to the target section's features").
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReferenceIntelligence, buildReferencePlanningContext } from "../index.js";
import { presentReferencePlanningContext, presentReferenceVerification } from "../present.js";
import { verifyReferenceProgress } from "../gap.js";
import { buildSectionPlanningContext } from "../../sections/context.js";
import { curSection, fv, refAnalysis, refSection } from "./fixtures.js";
import type { SectionFeatures } from "../../features/types.js";
import type { MusicIntelligence } from "../../intelligence/types.js";
import type { MusicGoal } from "../../../goal/types.js";

// ---------------------------------------------------------------------------
// Literal current-set intelligence (Intro / Build / Drop 1 / Drop 2)
// ---------------------------------------------------------------------------

function currentIntel(over: Record<string, Partial<SectionFeatures>> = {}): MusicIntelligence {
  let beat = 0;
  const mk = (id: string, name: string, energy: number | undefined, density: number): SectionFeatures => {
    const s = curSection(id, name, {
      startBeat: beat,
      endBeat: beat + 32,
      ...(energy !== undefined ? { energy: fv(energy) } : {}),
      density,
      rhythmicActivity: fv(0.5),
      ...over[id],
    });
    beat += 32;
    return s;
  };
  const sections = [
    mk("0", "Intro", 0.2, 0.5),
    mk("1", "Build", 0.5, 2),
    mk("2", "Drop 1", 0.8, 4),
    mk("3", "Drop 2", 0.61, 2),
  ];
  return {
    features: {
      sections,
      tracks: [],
      song: {
        durationBeats: beat,
        bars: beat / 4,
        trackCount: 0,
        midiTrackCount: 0,
        audioTrackCount: 0,
        tempo: 124,
        sectionCount: sections.length,
      },
    },
    relationships: {
      contrasts: [],
      similarities: [],
      arc: { energyCurve: sections.map((s) => s.energy?.value), energyCoverage: 1, peakSectionId: "2" },
    },
    reasoning: { observations: [], coverage: { sections: sections.length, analyzedSections: sections.length } },
    actions: { actions: [], coverage: { sourceObservations: 0, actionableObservations: 0 } },
  };
}

function goalOf(over: Partial<MusicGoal> = {}): MusicGoal {
  return {
    type: "edit",
    objective: "make Drop 2 closer to the reference",
    constraints: [],
    successCriteria: [],
    ...over,
  };
}

/** Reference: quiet intro + two drops (Fixture D shape). */
function twoDropAnalysis() {
  return refAnalysis([
    refSection(0, { role: "intro", label: "Intro 1", startBeat: 0, endBeat: 32, features: { energy: fv(0.25) } }),
    refSection(1, {
      role: "drop",
      label: "Drop 1",
      startBeat: 32,
      endBeat: 64,
      features: { energy: fv(0.85), density: fv(7.1), rhythmicActivity: fv(0.75), impact: fv(0.9) },
    }),
    refSection(2, {
      role: "drop",
      label: "Drop 2",
      startBeat: 64,
      endBeat: 96,
      features: { energy: fv(0.82), density: fv(7.1), rhythmicActivity: fv(0.75), impact: fv(0.88) },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// §54 — Scenario 1: "make my second drop closer to this reference"
// ---------------------------------------------------------------------------

test("Scenario 1: target aligns, gaps derive, actions suggest, context rides the section block", () => {
  const intel = currentIntel();
  const analysis = twoDropAnalysis();

  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  // Drop 2 ↔ reference Drop 2 (role + ordinal).
  assert.equal(refIntel.alignments[0].referenceSectionId, "reference:section:2");

  const energyGap = refIntel.gaps.find((g) => g.metric === "energy");
  const densityGap = refIntel.gaps.find((g) => g.metric === "density");
  assert.equal(energyGap?.direction, "higher_in_reference");
  assert.equal(energyGap?.delta, 0.21);
  assert.equal(densityGap?.direction, "higher_in_reference");

  const kinds = refIntel.actions.map((a) => a.kind);
  assert.ok(kinds.includes("increase_energy"));
  assert.ok(kinds.includes("increase_density"));
  assert.ok(kinds.includes("increase_rhythmic_activity"));

  // The reference block rides the section planning context.
  const goal = goalOf({ target: { section: "Drop 2" } });
  const sctx = buildSectionPlanningContext(goal, { ...intel, reference: refIntel });
  assert.ok(sctx !== undefined);
  assert.ok(sctx.reference !== undefined);
  assert.equal(sctx.reference.referenceSectionId, "reference:section:2");

  // Presentation: bounded, names the match and the headline gaps.
  const block = presentReferencePlanningContext(sctx.reference);
  assert.equal((block.reference as { match: string }).match, "reference:section:2");
  const metrics = (block.gaps as { metric: string }[]).map((g) => g.metric);
  assert.ok(metrics.includes("energy"));
  assert.ok(metrics.includes("density"));

  // --- Mock execution: the planner raised the target's energy/density ---
  const afterIntel = currentIntel({ "3": { energy: fv(0.77), density: 6.5, rhythmicActivity: fv(0.68) } });
  const refIntelAfter = buildReferenceIntelligence(analysis, afterIntel.features.sections, { targetSectionId: "3" });
  const afterCtx = buildReferencePlanningContext(sctx.target, afterIntel.features.sections, refIntelAfter);
  assert.ok(afterCtx !== undefined);

  const vers = verifyReferenceProgress(sctx.reference, afterCtx);
  const energyVer = vers.find((v) => v.metric === "energy");
  assert.equal(energyVer?.beforeGap, 0.21);
  assert.equal(energyVer?.afterGap, 0.05);
  assert.equal(energyVer?.satisfied, true);
  // All gaps moved → no complaint lines.
  assert.deepEqual(presentReferenceVerification(vers), []);
});

// ---------------------------------------------------------------------------
// §56 — Scenario 3: unknown on the reference side stays unknown
// ---------------------------------------------------------------------------

test("Scenario 3: undefined reference energy yields NO energy gap/action; density still compares", () => {
  const intel = currentIntel();
  const analysis = refAnalysis([
    refSection(0, { role: "drop", label: "Drop 1", startBeat: 0, endBeat: 32, features: { density: fv(8) } }),
  ]);
  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  assert.equal(refIntel.gaps.find((g) => g.metric === "energy"), undefined);
  assert.equal(refIntel.gaps.find((g) => g.metric === "density")?.direction, "higher_in_reference");
  const kinds = refIntel.actions.map((a) => a.kind);
  assert.deepEqual(kinds, ["increase_density"]);
  assert.ok(!kinds.includes("increase_energy"));
});

// ---------------------------------------------------------------------------
// §57 — Scenario 4: tiny differences are not a call to action
// ---------------------------------------------------------------------------

test("Scenario 4: near-identical sections produce no meaningful gaps and no actions", () => {
  const intel = currentIntel({ "3": { energy: fv(0.8), density: 7, rhythmicActivity: fv(0.7) } });
  const analysis = refAnalysis([
    refSection(0, {
      role: "drop",
      label: "Drop 1",
      startBeat: 0,
      endBeat: 32,
      features: { energy: fv(0.82), density: fv(7.1), rhythmicActivity: fv(0.71) },
    }),
  ]);
  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  assert.ok(refIntel.gaps.every((g) => g.direction === "similar"));
  assert.deepEqual(refIntel.actions, []);
});

// ---------------------------------------------------------------------------
// §58 — Scenario 5: a failed gate feeds the retry the exact remaining gaps
// ---------------------------------------------------------------------------

test("Scenario 5: insufficient progress surfaces the named gaps for the retry", () => {
  const intel = currentIntel();
  const analysis = twoDropAnalysis();
  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  const sctx = buildSectionPlanningContext(goalOf({ target: { section: "Drop 2" } }), { ...intel, reference: refIntel });
  assert.ok(sctx?.reference !== undefined);

  // First attempt barely moved: 0.21 → 0.18 (below the 0.03 reduction floor).
  const afterIntel = currentIntel({ "3": { energy: fv(0.64), density: 2.2 } });
  const refIntelAfter = buildReferenceIntelligence(analysis, afterIntel.features.sections, { targetSectionId: "3" });
  const afterCtx = buildReferencePlanningContext(sctx.target, afterIntel.features.sections, refIntelAfter);
  assert.ok(afterCtx !== undefined);

  const vers = verifyReferenceProgress(sctx.reference, afterCtx);
  const energyVer = vers.find((v) => v.metric === "energy");
  assert.equal(energyVer?.afterGap, 0.18);
  assert.equal(energyVer?.satisfied, false);

  const lines = presentReferenceVerification(vers);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /energy/);
  assert.match(lines[0], /0.21/);
  assert.match(lines[0], /0.18/);
});

// ---------------------------------------------------------------------------
// §62/§64 — backward compatibility: no reference → everything exactly as before
// ---------------------------------------------------------------------------

test("no reference: section context carries no reference block, intelligence untouched", () => {
  const intel = currentIntel();
  assert.equal(intel.reference, undefined);
  const sctx = buildSectionPlanningContext(goalOf({ target: { section: "Drop 2" } }), intel);
  assert.ok(sctx !== undefined);
  assert.equal(sctx.reference, undefined);
});

test("no alignment: reference intelligence is honest about the miss", () => {
  const intel = currentIntel();
  const analysis = refAnalysis([]); // analyzed, but no sections found
  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  assert.deepEqual(refIntel.alignments, []);
  assert.deepEqual(refIntel.gaps, []);
  assert.deepEqual(refIntel.actions, []);
  assert.equal(refIntel.coverage.alignment, 0);
  const sctx = buildSectionPlanningContext(goalOf({ target: { section: "Drop 2" } }), { ...intel, reference: refIntel });
  assert.ok(sctx !== undefined);
  assert.equal(sctx.reference, undefined);
});

// ---------------------------------------------------------------------------
// §55 — Scenario 2: reference + user goal coexist; goal wins on variation
// ---------------------------------------------------------------------------

test("Scenario 2: reference pushes energy while the user's variation axis stays goal-driven", () => {
  // The reference is denser/louder but LESS varied — a conservative mapper
  // never turns "reference has less variation" into a decrease command.
  const intel = currentIntel({ "3": { variation: 0.6 } });
  const analysis = refAnalysis([
    refSection(0, {
      role: "drop",
      label: "Drop 1",
      startBeat: 0,
      endBeat: 32,
      features: { energy: fv(0.85), variation: fv(0.3) },
    }),
  ]);
  const refIntel = buildReferenceIntelligence(analysis, intel.features.sections, { targetSectionId: "3" });
  const kinds = refIntel.actions.map((a) => a.kind);
  assert.ok(kinds.includes("increase_energy"));
  // variation is LOWER in the reference: the conservative mapping stays
  // silent — the user's "keep your own variation" goal is never overridden.
  assert.ok(!kinds.includes("increase_repetition"));
  assert.ok(!kinds.includes("introduce_variation"));
});
