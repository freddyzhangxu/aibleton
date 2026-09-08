/**
 * plan/check.ts — judges a declared plan against what actually happened.
 *
 * Two independent judgements, both deterministic and both pure over plain
 * data (no Live, no SDK — fixtures exercise them offline):
 *
 * 1. EXECUTION: which steps actually ran. Replayed from the turn's executed
 *    tool-name log (server.ts records every call that ran, including ones
 *    whose verify failed — "executed but missed target" is a diagnosis, not
 *    "never happened"). A cursor walks the steps in declaration order; each
 *    logged tool name advances it to the first unexecuted step naming that
 *    tool. Steps the cursor never reaches are reported as unexecuted.
 *
 * 2. EFFECTS: which predicted effects were observed. Each ExpectedEffect is
 *    judged against the SAME (baseline, after) GoalViews the goal gate uses,
 *    so a plan effect and a goal criterion can never disagree about the
 *    numbers. A missing reference (section renamed away, track deleted) is
 *    "not observed" with the available names as `actual` — mirroring
 *    goal/evaluate.ts: could-not-find is a finding, not an exception.
 *
 * Effects are judged baseline→after, not per-step: intermediate steps may
 * temporarily move a metric the wrong way. Attribution to steps is still
 * useful — an unobserved effect names the step whose INTENT didn't survive
 * to the final state, which is where the retry should look first.
 */

import { findSection, type GoalView } from "../goal/view.js";
import type { EffectDirection, ExpectedEffect, MusicPlan, PlanStep } from "./types.js";

const fmt = (v: number): string => String(Math.round(v * 100) / 100);
const EPS = 1e-6;

/** kick|bass — same "low-end" shorthand as goal/evaluate.ts. */
const ROLE_GROUPS: Record<string, string[]> = {
  low_end: ["kick", "bass"],
};

export interface EffectCheck {
  id: string;
  observed: boolean;
  expected: string;
  actual?: string;
}

export interface StepReport {
  id: string;
  description: string;
  tool?: string;
  executed: boolean;
  effects: EffectCheck[];
}

export interface PlanReport {
  total: number;
  executedCount: number;
  steps: StepReport[];
  /** Steps the tool-call replay never reached. */
  unexecuted: StepReport[];
  /** Predicted effects that did not materialize, flattened across steps. */
  unobserved: (EffectCheck & { stepId: string; description: string })[];
}

// ---------------------------------------------------------------------------
// Effect judges — one per metric, same shape as goal/evaluate.ts's judges.
// ---------------------------------------------------------------------------

const DIR_LABEL: Record<EffectDirection, string> = { increase: "上升", decrease: "下降" };

function moved(direction: EffectDirection, before: number, after: number): boolean {
  return direction === "increase" ? after > before + EPS : after < before - EPS;
}

function sectionMissing(name: string, view: GoalView): string {
  return `可用段落: ${view.sections.map((s) => s.name).join(", ") || "(无)"}`;
}

function judgeSectionMetric(
  fx: ExpectedEffect & { metric: "section_energy" | "section_tracks" },
  before: GoalView,
  after: GoalView,
): EffectCheck {
  const label = fx.metric === "section_energy" ? "能量密度" : "参与轨数";
  const unit = fx.metric === "section_energy" ? "/bar" : "";
  const id = `section[${fx.section}].${fx.metric === "section_energy" ? "energy" : "tracks"}`;
  const take = (s: { notes: number; density: number; tracks: number }) =>
    fx.metric === "section_energy" ? s.density : s.tracks;

  const sa = findSection(after, fx.section!);
  if (!sa) {
    return { id, observed: false, expected: `段落「${fx.section}」存在`, actual: sectionMissing(fx.section!, after) };
  }
  const sb = findSection(before, fx.section!);
  if (!sb) {
    return { id, observed: false, expected: `基线中存在段落「${fx.section}」`, actual: sectionMissing(fx.section!, before) };
  }
  const vb = take(sb);
  const va = take(sa);
  return {
    id,
    observed: moved(fx.direction!, vb, va),
    expected: `「${sa.name}」${label}${DIR_LABEL[fx.direction!]}（基线 ${fmt(vb)}${unit}）`,
    actual: `${fmt(vb)} → ${fmt(va)}${unit}`,
  };
}

function judgeTrackNotes(fx: ExpectedEffect, before: GoalView, after: GoalView): EffectCheck {
  const id = `track[${fx.track}].notes`;
  const norm = fx.track!.trim().toLowerCase();
  const ta = after.tracks.find((t) => t.name.toLowerCase() === norm);
  if (!ta) {
    return {
      id,
      observed: false,
      expected: `轨道「${fx.track}」存在`,
      actual: `现有轨道: ${after.tracks.map((t) => t.name).join(", ") || "(空)"}`,
    };
  }
  const tb = before.tracks.find((t) => t.name.toLowerCase() === norm);
  const vb = tb?.notes ?? 0; // a track born mid-task starts from zero
  return {
    id,
    observed: moved(fx.direction!, vb, ta.notes),
    expected: `「${ta.name}」音符数${DIR_LABEL[fx.direction!]}（基线 ${vb}）`,
    actual: `${vb} → ${ta.notes}`,
  };
}

function judgeRoleAudible(fx: ExpectedEffect, after: GoalView): EffectCheck {
  const want = ROLE_GROUPS[fx.role!] ?? [fx.role!];
  const id = fx.section ? `role[${fx.role}]@${fx.section}` : `role[${fx.role}]`;
  const sec = fx.section ? findSection(after, fx.section) : undefined;
  if (fx.section && !sec) {
    return { id, observed: false, expected: `段落「${fx.section}」存在`, actual: sectionMissing(fx.section, after) };
  }
  const scope: ReadonlySet<string> = sec ? sec.roles : after.songRoles;
  const scopeLabel = fx.section ? `「${fx.section}」` : "全曲";
  const hit = want.some((r) => scope.has(r));
  return {
    id,
    observed: hit,
    expected: `${scopeLabel}可听见 ${fx.role}${ROLE_GROUPS[fx.role!] ? `（${want.join("|")}）` : ""}`,
    actual: `现有角色: ${[...scope].join(", ") || "(无)"}`,
  };
}

/** One judged effect. Every metric has exactly one judge here. */
export function checkEffect(fx: ExpectedEffect, before: GoalView, after: GoalView): EffectCheck {
  switch (fx.metric) {
    case "section_energy":
    case "section_tracks":
      return judgeSectionMetric(fx as ExpectedEffect & { metric: "section_energy" | "section_tracks" }, before, after);
    case "track_notes":
      return judgeTrackNotes(fx, before, after);
    case "track_count": {
      const vb = before.trackCount;
      const va = after.trackCount;
      return {
        id: "trackCount",
        observed: moved(fx.direction!, vb, va),
        expected: `轨道总数${DIR_LABEL[fx.direction!]}（基线 ${vb}）`,
        actual: `${vb} → ${va}`,
      };
    }
    case "tempo": {
      const vb = before.tempo;
      const va = after.tempo;
      return {
        id: "tempo",
        observed: moved(fx.direction!, vb, va),
        expected: `速度${DIR_LABEL[fx.direction!]}（基线 ${fmt(vb)} BPM）`,
        actual: `${fmt(vb)} → ${fmt(va)} BPM`,
      };
    }
    case "role_audible":
      return judgeRoleAudible(fx, after);
  }
}

// ---------------------------------------------------------------------------
// Execution replay + report assembly.
// ---------------------------------------------------------------------------

/** Which steps the turn's tool-call log covers. Pure — the log is plain
 * strings, so tests need no server. Meta tools (set_goal/set_plan themselves)
 * must already be filtered out by the caller. */
export function executedStepIds(steps: PlanStep[], executedTools: readonly string[]): Set<string> {
  const done = new Set<string>();
  let cursor = 0;
  for (const tool of executedTools) {
    for (let i = cursor; i < steps.length; i++) {
      if (!done.has(steps[i].id) && steps[i].tool === tool) {
        done.add(steps[i].id);
        cursor = i + 1;
        break;
      }
    }
  }
  return done;
}

/** Full plan judgement: execution replay + per-step effect checks. */
export function buildPlanReport(
  plan: MusicPlan,
  executedTools: readonly string[],
  before: GoalView,
  after: GoalView,
): PlanReport {
  const done = executedStepIds(plan.steps, executedTools);
  const steps: StepReport[] = plan.steps.map((s) => ({
    id: s.id,
    description: s.description,
    ...(s.tool ? { tool: s.tool } : {}),
    executed: done.has(s.id),
    effects: s.expectedEffects.map((fx) => checkEffect(fx, before, after)),
  }));
  const unexecuted = steps.filter((s) => !s.executed);
  const unobserved = steps.flatMap((s) =>
    s.effects
      .filter((fx) => !fx.observed)
      .map((fx) => ({ ...fx, stepId: s.id, description: s.description })),
  );
  return {
    total: steps.length,
    executedCount: steps.length - unexecuted.length,
    steps,
    unexecuted,
    unobserved,
  };
}
