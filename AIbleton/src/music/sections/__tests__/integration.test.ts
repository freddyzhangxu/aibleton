/**
 * integration.test.ts — the PR15 acceptance chain over the REAL layers:
 *
 *   MusicState → Features → Relationships → Reasoning → Actions
 *   → SectionTarget → SectionPlanningContext → (mock edit) → new MusicState
 *   → new Intelligence → SectionVerification: PASSED
 *
 * plus the plan layer's scope normalization (optional, malformed-safe,
 * backward compatible).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicIntelligence } from "../../intelligence/index.js";
import { normalizePlan } from "../../../plan/types.js";
import { buildSectionPlanningContext, presentSectionPlanningContext } from "../context.js";
import { verifySectionChange } from "../verify.js";
import { goalOf } from "./fixtures.js";
import {
  midiClip,
  note,
  repeatSnapshot,
  sixteenthNotes,
  snapshot,
  track,
} from "../../intelligence/__tests__/fixtures.js";

test("acceptance: make the second drop evolve from the first — PASSED", () => {
  // Before: Drop 1 / Verse / Drop 2, the two Drops feature-identical.
  const beforeIntel = buildMusicIntelligence(buildMusicState(repeatSnapshot()));
  const goal = goalOf({
    type: "edit",
    target: { section: "second drop" },
    objective: "make the second drop evolve from the first",
    successCriteria: [{ kind: "tempo_unchanged" }],
  });

  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx, "target must resolve on the real chain");
  assert.equal(ctx.target.name, "Drop 2");
  assert.equal(ctx.target.match, "ordinal");
  // Drop 1 is the musically decisive reference for a second-drop goal.
  assert.ok(ctx.references.some((r) => r.name === "Drop 1"));
  // The reasoning layer sees the repeat; the planner is told so.
  assert.ok(ctx.observations.some((o) => o.kind === "section_reprise" || o.kind === "repeated_section_low_variation"));
  assert.ok(ctx.actions.some((a) => a.kind === "introduce_variation" || a.kind === "develop_section"));
  // The presented block is bounded and names the target.
  const presented = presentSectionPlanningContext(ctx);
  assert.equal((presented.target as Record<string, unknown>).name, "Drop 2");

  // Mock edit: Drop 2's clip is rewritten as a TWO-BAR loop with a varied
  // pattern (the planner's introduce_variation, executed — a 1-bar loop
  // tiled 8× becomes a 2-bar loop tiled 4×, so loop-repeat share drops and
  // variation rises). Everything else identical.
  const sectionBeats = 8 * 4;
  const varied = [
    note(36, 0, 1),
    note(36, 1.5, 0.5),
    note(36, 2, 1),
    note(38, 3, 1),
    note(36, 4, 0.5),
    note(42, 5, 0.5),
    note(36, 6, 1),
    note(45, 7, 1),
  ];
  const afterSnapshot = snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("d1", sixteenthNotes(1), { start: 0, duration: sectionBeats }),
        midiClip("v", [note(36, 0, 1)], { start: sectionBeats, duration: sectionBeats }),
        midiClip("d2", varied, { start: 2 * sectionBeats, duration: sectionBeats, loopEnd: 8 }),
      ]),
    ],
    {
      cuePoints: [
        { time: 0, name: "Drop 1" },
        { time: sectionBeats, name: "Verse" },
        { time: 2 * sectionBeats, name: "Drop 2" },
      ],
    },
  );
  const afterIntel = buildMusicIntelligence(buildMusicState(afterSnapshot));

  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, goal);
  assert.equal(ver.matchedAfter, true);
  assert.equal(ver.target.afterSectionId, ctx.target.sectionId);
  const variation = ver.criteria.find((c) => c.metric === "variation");
  assert.ok(variation, "variation criterion expected from the variation actions");
  assert.equal(variation.status, "passed");
  assert.ok(variation.before !== undefined && variation.after !== undefined);
  assert.ok(variation.after > variation.before);
  assert.equal(ver.status, "passed");
});

test("target re-resolves identically on an UNCHANGED after-state (no false failure)", () => {
  const beforeIntel = buildMusicIntelligence(buildMusicState(repeatSnapshot()));
  const goal = goalOf({
    target: { section: "second drop" },
    successCriteria: [{ kind: "section_energy_gt", a: "Drop 2", b: "baseline:Drop 2" }],
  });
  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx);
  const afterIntel = buildMusicIntelligence(buildMusicState(repeatSnapshot()));
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, goal);
  // Nothing changed: the increase criterion honestly reports failed (delta 0
  // is below threshold) — evidence for the retry, never a crash.
  assert.equal(ver.matchedAfter, true);
  assert.equal(ver.status, "failed");
  const e = ver.criteria.find((c) => c.metric === "energy");
  assert.ok(e);
  assert.equal(e.delta, 0);
});

// ---------------------------------------------------------------------------
// Plan scope normalization (plan/types.ts)
// ---------------------------------------------------------------------------

const VALID = new Set(["write_midi_clip"]);

test("plan scope: valid scope is preserved (section name or id spelling)", () => {
  const byName = normalizePlan(
    { steps: [{ description: "add hats", tool: "write_midi_clip", scope: { section: "Drop 2", startBeat: 160, endBeat: 192 } }] },
    VALID,
  );
  assert.ok(byName.steps);
  assert.deepEqual(byName.steps[0].scope, { section: "Drop 2", startBeat: 160, endBeat: 192 });

  const byId = normalizePlan(
    { steps: [{ description: "add hats", scope: { sectionId: "5" } }] },
    VALID,
  );
  assert.ok(byId.steps);
  assert.deepEqual(byId.steps[0].scope, { section: "5" });
});

test("plan scope: malformed pieces are dropped, never a crash", () => {
  const bad = normalizePlan(
    {
      steps: [
        { description: "nan beats", scope: { section: "Drop", startBeat: NaN, endBeat: 10 } },
        { description: "infinity", scope: { startBeat: 0, endBeat: Infinity } },
        { description: "negative", scope: { startBeat: -4, endBeat: 8 } },
        { description: "inverted", scope: { startBeat: 192, endBeat: 160 } },
        { description: "not an object", scope: "Drop 2" },
      ],
    },
    VALID,
  );
  assert.ok(bad.steps);
  // Section name survives a bad beat range; beats are dropped.
  assert.deepEqual(bad.steps[0].scope, { section: "Drop" });
  assert.equal(bad.steps[1].scope, undefined);
  assert.equal(bad.steps[2].scope, undefined);
  assert.equal(bad.steps[3].scope, undefined);
  assert.equal(bad.steps[4].scope, undefined);
  assert.ok(bad.warnings.length >= 4);
});

test("plan scope: old plans without scope are untouched", () => {
  const legacy = normalizePlan(
    { steps: [{ description: "raise cutoff", tool: "write_midi_clip", expectedEffects: [{ metric: "section_energy", section: "Drop", direction: "increase" }] }] },
    VALID,
  );
  assert.ok(legacy.steps);
  assert.equal(legacy.steps[0].scope, undefined);
  assert.equal(legacy.steps[0].expectedEffects.length, 1);
});
