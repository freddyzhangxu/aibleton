/**
 * quality.test.ts — PR15.5 Agent Quality Pass: four REAL user scenarios,
 * each driven end-to-end over the real chain:
 *
 *   raw set_goal input → normalizeGoal → MusicState → MusicIntelligence
 *   → SectionTarget resolution → reference selection → planning context
 *   (what the model is TOLD) → mock edit → rebuilt intelligence
 *   → SectionVerification (what actually CHANGED) → retry diagnosis
 *
 * The scenarios are the acceptance checklist for PR11–15 as one Musical
 * Intelligence + Agent Planning architecture:
 *
 *   A. "让 Drop 更有冲击力"
 *      — finds the Drop · references the Build · surfaces
 *        increase_section_contrast · contrast really rises after the edit
 *   B. "让第二个 Drop 和第一个 Drop 有变化"
 *      — resolves Drop 1 / Drop 2 by ordinal · picks Drop 1 as the
 *        reference · surfaces introduce_variation · variation rises AND
 *        similarity drops after the edit
 *   C. "让 Breakdown 更空一点，但不要太空"
 *      — the planner sees energy + density + active tracks together · a
 *        gut-the-section edit FAILS on the layering guard (never silently
 *        passes) · a surgical thinning PASSES
 *   D. Failure → Retry
 *      — a too-small edit fails on NAMED criteria (metric + numbers) · the
 *        loop allows exactly one bounded retry · a targeted second edit
 *        passes the very criteria that failed — never a random re-roll
 *
 * Mock edits are honest: they are second snapshots through the SAME chain,
 * so a passing verdict means the measured features really moved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_MAX_STEPS, gateAction, mutationsLeft } from "../../../agent/loop.js";
import { normalizeGoal, type MusicGoal } from "../../../goal/types.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import type { SnapshotNote, SongSnapshot } from "../../../musicstate/types.js";
import { buildMusicIntelligence } from "../../intelligence/index.js";
import type { MusicIntelligence } from "../../intelligence/types.js";
import {
  fourOnFloor,
  midiClip,
  note,
  repeatSnapshot,
  sixteenthNotes,
  snapshot,
  track,
} from "../../intelligence/__tests__/fixtures.js";
import { buildSectionPlanningContext, presentSectionPlanningContext } from "../context.js";
import { resolveSectionTarget } from "../resolve.js";
import {
  presentSectionVerification,
  SECTION_DELTA_THRESHOLDS,
  verifySectionChange,
} from "../verify.js";
import type { SectionVerification, SectionVerificationMetric } from "../types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SB = 8 * 4; // one section = 8 bars = 32 beats

/** Raw set_goal tool input → normalized MusicGoal (the model's real entry). */
function goalFromRaw(raw: Record<string, unknown>): MusicGoal {
  const norm = normalizeGoal(raw);
  assert.ok(norm.goal, `goal must normalize — warnings: ${norm.warnings.join("; ")}`);
  return norm.goal;
}

const intelOf = (snap: SongSnapshot): MusicIntelligence =>
  buildMusicIntelligence(buildMusicState(snap));

const vel = (ns: SnapshotNote[], v: number): SnapshotNote[] =>
  ns.map((n) => ({ ...n, velocity: v }));

/** 8th-note pulse: 2 onsets per beat. */
function eighthNotes(bars: number, pitch = 36, velocity = 100): SnapshotNote[] {
  const out: SnapshotNote[] = [];
  for (let b = 0; b < bars * 4; b++) {
    out.push(note(pitch, b, 0.5, velocity), note(pitch, b + 0.5, 0.5, velocity));
  }
  return out;
}

function crit(
  ver: SectionVerification,
  metric: SectionVerificationMetric,
  referenceSectionId?: string,
) {
  const c = ver.criteria.find(
    (x) =>
      x.metric === metric &&
      (referenceSectionId === undefined || x.referenceSectionId === referenceSectionId),
  );
  assert.ok(c, `criterion ${metric} expected`);
  return c;
}

// ---------------------------------------------------------------------------
// Scenario A song — "让 Drop 更有冲击力"
//
// The realistic complaint behind the goal: the Drop does NOT hit — it is the
// same material as the Build (flat arrangement, weak contrast). Kick v100 +
// Bass v80, identical 1-bar loops in both sections.
// ---------------------------------------------------------------------------

function weakDropSong(dropKick: SnapshotNote[], dropBass: SnapshotNote[]): SongSnapshot {
  return snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("k-build", fourOnFloor(1), { start: 0, duration: SB }),
        midiClip("k-drop", dropKick, { start: SB, duration: SB }),
      ]),
      track(1, "Bass", "midi", [
        midiClip("b-build", vel(fourOnFloor(1, 40), 80), { start: 0, duration: SB }),
        midiClip("b-drop", dropBass, { start: SB, duration: SB }),
      ]),
    ],
    {
      cuePoints: [
        { time: 0, name: "Build" },
        { time: SB, name: "Drop" },
      ],
    },
  );
}

/** Before: Drop = Build material (the drop that doesn't hit). */
const songABefore = () => weakDropSong(fourOnFloor(1), vel(fourOnFloor(1, 40), 80));

/** The planner's increase_section_contrast, executed: 16ths kick + 8ths bass. */
const songAPowered = () =>
  weakDropSong(vel(sixteenthNotes(1), 110), eighthNotes(1, 40, 100));

/** A too-small edit: same material, velocities nudged up only. */
const songAVelocityBump = () =>
  weakDropSong(vel(fourOnFloor(1), 112), vel(fourOnFloor(1, 40), 90));

const goalARaw: Record<string, unknown> = {
  type: "edit",
  target: { section: "Drop" },
  objective: "让 Drop 更有冲击力",
  successCriteria: [
    { kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" },
    { kind: "section_energy_gt", a: "Drop", b: "Build" },
  ],
};

// ---------------------------------------------------------------------------
// Scenario B song — repeatSnapshot() (Drop 1 / Verse / Drop 2 identical) from
// the intelligence fixtures; the after-state varies Drop 2 (2-bar loop with a
// varied pattern tiled 4× — variation rises, similarity drops).
// ---------------------------------------------------------------------------

function variedSecondDropSong(): SongSnapshot {
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
  return snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("d1", sixteenthNotes(1), { start: 0, duration: SB }),
        midiClip("v", [note(36, 0, 1)], { start: SB, duration: SB }),
        midiClip("d2", varied, { start: 2 * SB, duration: SB, loopEnd: 8 }),
      ]),
    ],
    {
      cuePoints: [
        { time: 0, name: "Drop 1" },
        { time: SB, name: "Verse" },
        { time: 2 * SB, name: "Drop 2" },
      ],
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario C song — Build / Drop / Breakdown / Drop 2, three tracks. The
// Breakdown starts nearly as full as the Drop (the "too full" complaint).
// ---------------------------------------------------------------------------

/** breakdown clips per track — undefined = the track has no clip there. */
interface BreakdownMaterial {
  kick?: SnapshotNote[];
  bass?: SnapshotNote[];
  pads?: SnapshotNote[];
  /** pads loop length in beats (2-bar loop for the thinned sustain). */
  padsLoopEnd?: number;
}

function breakdownSong(bd: BreakdownMaterial): SongSnapshot {
  const dropKick = vel(sixteenthNotes(1), 105);
  const dropBass = eighthNotes(1, 40, 95);
  const dropPads = [note(60, 0, 2, 80), note(64, 2, 2, 80)];
  const kickClips = [
    midiClip("k-build", fourOnFloor(1), { start: 0, duration: SB }),
    midiClip("k-drop", dropKick, { start: SB, duration: SB }),
    ...(bd.kick
      ? [midiClip("k-bd", bd.kick, { start: 2 * SB, duration: SB })]
      : []),
    midiClip("k-drop2", dropKick, { start: 3 * SB, duration: SB }),
  ];
  const bassClips = [
    midiClip("b-build", vel(fourOnFloor(1, 40), 85), { start: 0, duration: SB }),
    midiClip("b-drop", dropBass, { start: SB, duration: SB }),
    ...(bd.bass
      ? [midiClip("b-bd", bd.bass, { start: 2 * SB, duration: SB })]
      : []),
    midiClip("b-drop2", dropBass, { start: 3 * SB, duration: SB }),
  ];
  const padsClips = [
    midiClip("p-drop", dropPads, { start: SB, duration: SB }),
    ...(bd.pads
      ? [
          midiClip("p-bd", bd.pads, {
            start: 2 * SB,
            duration: SB,
            ...(bd.padsLoopEnd !== undefined ? { loopEnd: bd.padsLoopEnd } : {}),
          }),
        ]
      : []),
    midiClip("p-drop2", dropPads, { start: 3 * SB, duration: SB }),
  ];
  return snapshot(
    [
      track(0, "Kick", "midi", kickClips),
      track(1, "Bass", "midi", bassClips),
      track(2, "Pads", "midi", padsClips),
    ],
    {
      cuePoints: [
        { time: 0, name: "Build" },
        { time: SB, name: "Drop" },
        { time: 2 * SB, name: "Breakdown" },
        { time: 3 * SB, name: "Drop 2" },
      ],
    },
  );
}

/** Before: Breakdown is nearly as full as the Drop (4+4+4 onsets/bar). */
const songCBefore = () =>
  breakdownSong({
    kick: vel(fourOnFloor(1), 95),
    bass: vel(fourOnFloor(1, 40), 85),
    pads: vel(fourOnFloor(1, 60), 75),
  });

/** The lazy failure mode: delete the bass and pads clips outright. */
const songCGutted = () =>
  breakdownSong({
    kick: [note(36, 0, 1, 90), note(36, 2, 1, 90)],
  });

/** The surgical answer: every track stays, the material thins out. */
const songCThinned = () =>
  breakdownSong({
    kick: [note(36, 0, 4, 90)],
    bass: [note(40, 0, 2, 85), note(43, 2, 2, 85)],
    pads: [note(60, 0, 8, 70)],
    padsLoopEnd: 8,
  });

const goalCRaw: Record<string, unknown> = {
  type: "edit",
  target: { section: "Breakdown" },
  objective: "让 Breakdown 更空一点，但不要太空",
  successCriteria: [
    { kind: "section_energy_gt", a: "baseline:Breakdown", b: "Breakdown" },
    { kind: "section_tracks_gte", section: "Breakdown", n: "baseline" },
  ],
};

// ---------------------------------------------------------------------------
// Scenario A — "让 Drop 更有冲击力"
// ---------------------------------------------------------------------------

test("quality A: make the Drop hit harder — target, Build reference, contrast action, real contrast rise", () => {
  const beforeIntel = intelOf(songABefore());
  const goal = goalFromRaw(goalARaw);

  // 1. The Drop is really found (exact label, full confidence).
  const res = resolveSectionTarget(goal, beforeIntel);
  assert.ok(res.matched);
  assert.equal(res.target.name, "Drop");
  assert.equal(res.target.match, "label");

  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx, "section context must build");

  // 2. The Build is the comparison anchor — the goal's own declared partner
  // outranks every organic signal.
  assert.equal(ctx.references[0].name, "Build");
  assert.equal(ctx.references[0].reason, "contrast");

  // 3. The action the planner is shown includes increase_section_contrast
  // (the arrangement IS measurably flat — the evidence fires).
  assert.ok(
    ctx.actions.some((a) => a.kind === "increase_section_contrast"),
    `increase_section_contrast must be surfaced, got: ${ctx.actions.map((a) => a.kind).join(", ")}`,
  );
  // ...and it survives presentation — this is what the model actually sees.
  const presented = presentSectionPlanningContext(ctx);
  assert.equal((presented.target as Record<string, unknown>).name, "Drop");
  const presentedRefs = presented.references as Array<Record<string, unknown>>;
  assert.equal(presentedRefs[0].name, "Build");
  assert.ok(
    (presented.actions as Array<Record<string, unknown>>).some(
      (a) => a.kind === "increase_section_contrast",
    ),
  );

  // 4. After the edit the contrast REALLY rises — both required criteria
  // (energy increase, contrast vs Build) clear the noise threshold.
  const afterIntel = intelOf(songAPowered());
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, goal);
  assert.equal(ver.matchedAfter, true);

  const energy = crit(ver, "energy");
  assert.equal(energy.required, true);
  assert.equal(energy.status, "passed");
  assert.ok(energy.delta !== undefined && energy.delta >= SECTION_DELTA_THRESHOLDS.energy);

  const buildId = ctx.references[0].sectionId;
  const contrast = crit(ver, "contrast", buildId);
  assert.equal(contrast.required, true);
  assert.equal(contrast.status, "passed");
  assert.ok(contrast.before !== undefined && contrast.after !== undefined);
  assert.ok(
    contrast.after > contrast.before,
    `contrast vs Build must rise (${contrast.before} → ${contrast.after})`,
  );

  // The relationship trail tells the same story: Build↔Drop gap widened.
  const relChange = ver.relationshipChanges.find(
    (r) => r.referenceSectionId === buildId && r.metric === "contrast",
  );
  assert.ok(relChange?.delta !== undefined && relChange.delta > 0);

  assert.equal(ver.status, "passed");
});

// ---------------------------------------------------------------------------
// Scenario B — "让第二个 Drop 和第一个 Drop 有变化"
// ---------------------------------------------------------------------------

test("quality B: vary the second Drop — ordinal resolution, Drop 1 reference, variation AND similarity move", () => {
  const beforeIntel = intelOf(repeatSnapshot());
  const goal = goalFromRaw({
    type: "edit",
    target: { section: "second drop" },
    objective: "让第二个 Drop 和第一个 Drop 有变化",
    successCriteria: [{ kind: "tempo_unchanged" }],
  });

  // 1. Drop 1 / Drop 2 are both found, by the right paths: "second drop" is
  // an ordinal pick onto Drop 2; "first drop" / the bare label land on Drop 1.
  const second = resolveSectionTarget(goal, beforeIntel);
  assert.ok(second.matched);
  assert.equal(second.target.name, "Drop 2");
  assert.equal(second.target.match, "ordinal");
  const first = resolveSectionTarget(
    goalFromRaw({ target: { section: "first drop" }, successCriteria: [{ kind: "tempo_unchanged" }] }),
    beforeIntel,
  );
  assert.ok(first.matched);
  assert.equal(first.target.name, "Drop 1");
  const byLabel = resolveSectionTarget(
    goalFromRaw({ target: { section: "Drop 1" }, successCriteria: [{ kind: "tempo_unchanged" }] }),
    beforeIntel,
  );
  assert.ok(byLabel.matched);
  assert.equal(byLabel.target.match, "label");

  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx);

  // 2. Drop 1 is THE reference (reprise partner, top relevance) — the
  // variation is judged against the first Drop, never in a vacuum.
  assert.equal(ctx.references[0].name, "Drop 1");
  assert.equal(ctx.references[0].reason, "reprise");

  // 3. introduce_variation is the action the planner is shown.
  assert.ok(
    ctx.actions.some((a) => a.kind === "introduce_variation"),
    `introduce_variation must be surfaced, got: ${ctx.actions.map((a) => a.kind).join(", ")}`,
  );

  // 4. After the edit BOTH halves of "有变化" move: the target's own
  // variation rises AND the pair's similarity drops — measured, thresholded.
  const afterIntel = intelOf(variedSecondDropSong());
  const ver = verifySectionChange(ctx, beforeIntel, afterIntel, goal);
  assert.equal(ver.matchedAfter, true);

  const variation = crit(ver, "variation");
  assert.equal(variation.status, "passed");
  assert.ok(variation.before !== undefined && variation.after !== undefined);
  assert.ok(variation.after > variation.before);
  assert.ok(variation.delta !== undefined && variation.delta >= SECTION_DELTA_THRESHOLDS.variation);

  const drop1Id = ctx.references[0].sectionId;
  const similarity = crit(ver, "similarity", drop1Id);
  assert.equal(similarity.direction, "decrease");
  assert.equal(similarity.status, "passed");
  assert.ok(similarity.before !== undefined && similarity.after !== undefined);
  assert.ok(
    similarity.after < similarity.before,
    `similarity vs Drop 1 must drop (${similarity.before} → ${similarity.after})`,
  );
  assert.ok(similarity.delta !== undefined && similarity.delta <= -SECTION_DELTA_THRESHOLDS.similarity);

  assert.equal(ver.status, "passed");
});

// ---------------------------------------------------------------------------
// Scenario C — "让 Breakdown 更空一点，但不要太空"
// ---------------------------------------------------------------------------

test("quality C: emptier Breakdown, not gutted — planner sees energy+density+tracks; gutting fails, thinning passes", () => {
  const beforeIntel = intelOf(songCBefore());
  const goal = goalFromRaw(goalCRaw);

  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx);
  assert.equal(ctx.target.name, "Breakdown");

  // 1. The planner sees all three axes of "空" at once — energy, note
  // density and active tracks — never a single "how loud" number.
  assert.ok(ctx.features.energy !== undefined, "energy must be projected");
  assert.ok(ctx.features.density !== undefined, "density must be projected");
  assert.ok(ctx.features.activeTrackRatio !== undefined, "active tracks must be projected");

  // 2. Failure mode: gutting the section. Energy DOES drop (that criterion
  // passes) — but the layering guard fails, and the diagnosis names exactly
  // that: active_track_ratio, not a vague "try again".
  const guttedIntel = intelOf(songCGutted());
  const gutVer = verifySectionChange(ctx, beforeIntel, guttedIntel, goal);
  assert.equal(gutVer.status, "failed");
  const gutEnergy = crit(gutVer, "energy");
  assert.equal(gutEnergy.direction, "decrease");
  assert.equal(gutEnergy.status, "passed");
  const gutTracks = crit(gutVer, "active_track_ratio");
  assert.equal(gutTracks.direction, "maintain");
  assert.equal(gutTracks.required, true);
  assert.equal(gutTracks.status, "failed");
  // No other criterion failed — the guard is the ONLY complaint.
  assert.deepEqual(
    gutVer.criteria.filter((c) => c.status === "failed").map((c) => c.metric),
    ["active_track_ratio"],
  );
  const gutLines = presentSectionVerification(gutVer, ctx.target.name).join("\n");
  assert.ok(gutLines.includes("Breakdown"));
  assert.ok(gutLines.includes("active_track_ratio"), `diagnosis must name the guard:\n${gutLines}`);

  // 3. The surgical edit: all tracks keep playing, the material thins —
  // energy drops past the threshold AND the layering guard holds.
  const thinnedIntel = intelOf(songCThinned());
  const thinVer = verifySectionChange(ctx, beforeIntel, thinnedIntel, goal);
  assert.equal(thinVer.status, "passed");
  const thinEnergy = crit(thinVer, "energy");
  assert.equal(thinEnergy.status, "passed");
  assert.ok(thinEnergy.delta !== undefined && thinEnergy.delta <= -SECTION_DELTA_THRESHOLDS.energy);
  const thinTracks = crit(thinVer, "active_track_ratio");
  assert.equal(thinTracks.status, "passed");
  assert.ok(
    thinTracks.delta !== undefined &&
      Math.abs(thinTracks.delta) <= SECTION_DELTA_THRESHOLDS.active_track_ratio,
  );
  // Density really went down too — "空" is measured, not asserted.
  const before = ctx.targetFeatures;
  const after = thinnedIntel.features.sections.find((s) => s.sectionId === ctx.target.sectionId);
  assert.ok(after && after.density < before.density);
});

// ---------------------------------------------------------------------------
// Scenario D — Failure → Retry
// ---------------------------------------------------------------------------

test("quality D: too-small edit fails on NAMED criteria; the bounded retry fixes exactly those", () => {
  const beforeIntel = intelOf(songABefore());
  const goal = goalFromRaw(goalARaw);
  const ctx = buildSectionPlanningContext(goal, beforeIntel);
  assert.ok(ctx);

  // 1. First attempt: a velocity nudge. Musically real, measurably TOO
  // SMALL — the REQUIRED criteria (the ones gating the verdict) move a
  // little but stay below the noise threshold. Supporting action-hints
  // (density/variation/…) did not change at all — they never gate.
  const smallIntel = intelOf(songAVelocityBump());
  const ver1 = verifySectionChange(ctx, beforeIntel, smallIntel, goal);
  assert.equal(ver1.status, "failed");
  const failedRequired = ver1.criteria
    .filter((c) => c.required && c.status === "failed")
    .map((c) => c.metric);
  assert.deepEqual(failedRequired.sort(), ["contrast", "energy"]);
  for (const m of failedRequired) {
    const c = crit(ver1, m as SectionVerificationMetric);
    assert.ok(c.delta !== undefined && c.delta > 0, `${m} moved, just not enough`);
    assert.ok(c.delta < SECTION_DELTA_THRESHOLDS[m as SectionVerificationMetric]);
  }

  // 2. The retry surface knows WHICH criteria missed, in WHICH section, by
  // HOW MUCH. The headline carries exactly the judged (required) criteria —
  // metric, direction, before→after numbers — so the retry targets the gap
  // instead of re-rolling. Supporting hints ride a separate, labeled line
  // and never dilute the complaint.
  const lines = presentSectionVerification(ver1, ctx.target.name);
  const headline = lines[0];
  assert.ok(headline.includes("Drop"), "the section is named");
  assert.ok(headline.includes("energy"), "the missed metric is named");
  assert.ok(headline.includes("contrast"), "the missed relative metric is named");
  assert.ok(headline.includes("increase"), "the expected direction is named");
  assert.ok(/Δ\+0\.0[0-9]/.test(headline), `the measured delta rides along:\n${headline}`);
  const supporting = lines.find((l) => l.includes("supporting"));
  assert.ok(supporting, "action-derived misses ride a subordinate line");
  assert.ok(
    !supporting.includes("energy 期望") && !supporting.includes("contrast 期望"),
    "judged criteria stay in the headline, never duplicated as hints",
  );

  // 3. The loop bound: exactly one retry with budget left — never an
  // open-ended tweak loop, never a retry that could only apologize.
  assert.equal(gateAction(false, 0, AGENT_MAX_STEPS - 1), "retry");
  assert.equal(gateAction(false, 1, AGENT_MAX_STEPS - 1), "stop");
  assert.equal(gateAction(true, 0, AGENT_MAX_STEPS - 1), "pass");
  const readOnly = new Set(["set_goal", "set_plan", "analyze_song"]);
  assert.equal(mutationsLeft(["write_midi_clip"], readOnly), AGENT_MAX_STEPS - 1);

  // 4. Second attempt, guided by the diagnosis: densify the Drop (the
  // energy axis the message named). The SAME criteria that failed now pass
  // — a targeted repair, not a re-roll.
  const poweredIntel = intelOf(songAPowered());
  const ver2 = verifySectionChange(ctx, beforeIntel, poweredIntel, goal);
  assert.equal(ver2.status, "passed");
  for (const m of failedRequired) {
    const c = crit(ver2, m as SectionVerificationMetric);
    assert.equal(c.status, "passed", `${m} must pass after the targeted fix`);
    assert.ok(c.delta !== undefined && c.delta >= SECTION_DELTA_THRESHOLDS[m as SectionVerificationMetric]);
  }
  // The retry message for the repaired state is silent (nothing to correct).
  assert.deepEqual(presentSectionVerification(ver2, ctx.target.name), []);
});
