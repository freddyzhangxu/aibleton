/** Stamp the latest genlog record onto a GoalView for the gen_* judges
 * (goalNeedsGenlog gates the call). Registry reads stay out of
 * buildGoalView itself, which measures only the Set. */
function attachLatestGeneration(view: GoalView): void {
  const rec = latestGeneration();
  if (!rec) return;
  view.latestGeneration = {
    id: rec.id,
    provider: rec.provider,
    ...(rec.features ? { features: rec.features } : {}),
    ...(rec.featuresError ? { featuresError: rec.featuresError } : {}),
  };
}

// Agent runtime: the stateful per-turn orchestration shared by every provider
// loop. Owns the turn bookkeeping (declared goal/plan lifecycle, mutation
// counters, refinement budget, reference-analysis cache); providers call
// callTool() per tool_use and goalGate() when the model stops. The pure
// policy (budgets, gate decisions) lives in ./loop.ts — this file is the
// mechanism that holds the state those decisions act on.
import {
  AGENT_MAX_REFINEMENTS,
  AGENT_MAX_RETRIES,
  countMutations,
  gateAction,
  mutationsLeft,
  refineHasNewArtifact,
  stepBudgetError,
  AGENT_MAX_STEPS,
} from "./loop.js";
import {
  goalNeedsAudio,
  goalNeedsGenlog,
  normalizeGoal,
  type GoalEvaluation,
  type MusicGoal,
} from "../goal/types.js";
import { buildGoalView, type GoalView } from "../goal/view.js";
import { evaluateGoal } from "../goal/evaluate.js";
import { normalizePlan, planNeedsAudio, type MusicPlan } from "../plan/types.js";
import { buildPlanReport, executedStepIds, type PlanReport } from "../plan/check.js";
import {
  buildMusicIntelligence,
  presentGoalContext,
  projectGoalContext,
  type MusicIntelligence,
} from "../music/intelligence/index.js";
import {
  buildSectionPlanningContext,
  presentSectionPlanningContext,
  presentSectionVerification,
  verifySectionChange,
  type SectionPlanningContext,
  type SectionVerification,
} from "../music/sections/index.js";
import {
  analyzeReferenceBuffer,
  buildReferenceIntelligence,
  buildReferencePlanningContext,
  presentReferencePlanningContext,
  presentReferenceVerification,
  verifyReferenceProgress,
  REFERENCE_ANALYZER_VERSION,
  type ReferenceAnalysis,
  type ReferenceError,
  type ReferenceSource,
} from "../music/reference/index.js";
import {
  diffGenerations,
  latestGeneration,
  loadGenLog,
  REFINE_DISCIPLINE,
  suggestForGenGap,
  type GenGap,
} from "../genlog/index.js";
import { analyzeMusicState } from "../analysis/index.js";
import { pcName } from "../analysis/interpret.js";
import { enrichMusicStateWithAudio } from "../audiofiles.js";
import { buildMusicState } from "../musicstate/builder.js";
import { readHomeBinary } from "../paths.js";
import { TOOLS } from "../tools/definitions.js";
import { runTool } from "../tools/dispatcher.js";
import { buildSongSnapshot } from "../tools/helpers.js";
import {
  askConfirmation,
  COSTLY_TOOLS,
  READ_ONLY_TOOLS,
  verifyToolResult,
} from "../chat/gates.js";
import * as fs from "node:fs";
import { toolHooks, type Ctx } from "../state.js";
import { truncateResult } from "../chat/session.js";

// ---------- Goal/Intent layer (goal/) ----------
//
// One declared goal per user turn. set_goal captures the baseline view at
// declaration time; when the model stops calling tools, goalGate evaluates
// the criteria and either lets the turn finish, injects a 目标校验 message so
// the loop keeps going (bounded), or — retries exhausted — appends a
// server-side note so the user sees the measured outcome, not the model's
// claim. PR4 verifies single tool calls; this verifies the TASK.
// The bounds (retries, mutation budget, round cap) live in agent/loop.ts.

let pendingGoal: {
  goal: MusicGoal;
  baseline: GoalView;
  /** The music/ stack chained over the SAME state the baseline view was
   * built from — the goal's projected reasoning slice rides the set_goal
   * result so the plan is written against measured evidence (PR13.5). */
  intel: MusicIntelligence;
  /** PR15: the goal's resolved section target + bounded planning context.
   * Absent when the goal names no resolvable section — the loop then runs
   * exactly as before (song-level behavior is the fallback, never a crash). */
  section?: SectionPlanningContext;
  /** PR16: the analyzed reference track (cached across retries — the gate
   * re-derives gaps against the after-state without re-decoding audio, §60).
   * referenceError records WHY no reference rides the goal; neither field
   * ever blocks the plain goal flow (reference is an enhancement, §62). */
  referenceAnalysis?: ReferenceAnalysis;
  referenceError?: ReferenceError;
  /** User-pinned reference section id (set_goal reference.section). */
  referencePinnedSectionId?: string;
  retries: number;
  /** Generation refinements spent this turn (PR19) — an independent counter
   * from retries: a refine regenerates the artifact, it never replans. */
  refinements: number;
  /** Generation id the last refine was fired against — a refine only burns
   * budget when a NEWER artifact shows up at the next gate (a text-only
   * answer to a refine injection must not spend the counter). */
  refineSeenGenId?: string;
  /** Declared after mutations already happened this turn — relative
   * ("baseline") criteria then compare against a mid-task state. */
  lateBaseline: boolean;
} | null = null;

// ---------- Reference Track Intelligence (music/reference) ----------
//
// A declared reference is analyzed ONCE per file identity and cached for the
// process lifetime (the audiofiles.ts idiom: path+mtime+size keying — best
// effort, §47). The analysis is pure dsp over the decoded bytes; the file
// itself never leaves the machine (§72: local analysis only).

interface ReferenceCacheEntry {
  mtimeMs: number;
  size: number;
  outcome: { analysis: ReferenceAnalysis } | { error: ReferenceError; message?: string };
}

const referenceCache = new Map<string, ReferenceCacheEntry>();

export function loadReferenceAnalysis(
  path: string,
  tempoBpm?: number,
): ReferenceCacheEntry["outcome"] {
  let mtimeMs = 0;
  let size: number | null = null;
  try {
    const st = fs.statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // stat denied (sandbox) or missing — read decides; keying degrades to
    // path-only, same documented trade-off as audiofiles.ts.
  }
  const hit = referenceCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && (size === null || hit.size === size) && tempoBpm === undefined) {
    return hit.outcome;
  }
  const buf = readHomeBinary(path);
  if (!buf) {
    const outcome = { error: "reference_unavailable" as const, message: "unreadable (missing or denied)" };
    referenceCache.set(path, { mtimeMs, size: size ?? 0, outcome });
    return outcome;
  }
  const source: ReferenceSource = { type: "audio_file", path };
  const outcome = analyzeReferenceBuffer(source, buf, { ...(tempoBpm !== undefined ? { tempoBpm } : {}) });
  if (tempoBpm === undefined) {
    referenceCache.set(path, { mtimeMs, size: buf.length, outcome });
  }
  return outcome;
}


/** Mutating calls that actually executed this turn (drives lateBaseline). */
let mutationsThisTurn = 0;

// ---------- Plan layer (plan/) ----------
//
// One declared plan per goal. set_plan attaches ordered steps — each with its
// tool and predicted expectedEffects — to the pending goal. The plan never
// gates (goal criteria alone decide "done"); it DIAGNOSES: when the goal gate
// fails, the retry injection names the steps that never executed and the
// predicted effects that were not observed, so self-correction targets the
// right step. Step execution is inferred server-side from the tool-call log —
// never from the model's own claims.

let pendingPlan: MusicPlan | null = null;

/** Every tool call that actually RAN this turn (denied/thrown excluded;
 * verify-failed INCLUDED — "executed but missed target" is not "never
 * happened"). Replayed against plan steps at declare/gate time. */
let executedToolsThisTurn: string[] = [];

/** Declaring intent (set_goal/set_plan) is not executing a plan step. */
const PLAN_META_TOOLS = new Set(["set_goal", "set_plan"]);

/** Known tool names for plan validation — built once from TOOLS. */
const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

export function handleSetPlan(context: Ctx, input: Record<string, unknown>): unknown {
  if (!pendingGoal) {
    throw new Error("set_plan 需要先声明目标 — 请先调用 set_goal（计划必须挂在目标上）。 / Call set_goal first: a plan belongs to a declared goal.");
  }
  const norm = normalizePlan(input, VALID_TOOL_NAMES);
  if (!norm.steps) {
    throw new Error(
      `set_plan 未生效：没有有效步骤。` + (norm.warnings.length ? ` ${norm.warnings.join("；")}` : ""),
    );
  }
  const warnings = [...norm.warnings];
  if (mutationsThisTurn > 0) {
    warnings.push(
      `注意：本回合已有 ${mutationsThisTurn} 次改动先于 set_plan 执行 — 计划应在动手之前声明（步骤匹配仍会回放已执行的调用）。`,
    );
  }
  pendingPlan = { goal: pendingGoal.goal, steps: norm.steps };
  // Replay the turn so far: a plan declared late still gets correct statuses.
  const done = executedStepIds(pendingPlan.steps, executedToolsThisTurn);
  toolHooks.debugLog(
    context,
    `PLAN set: ${norm.steps.length} steps for goal「${pendingGoal.goal.objective}」· already executed=${done.size}`,
  );
  return {
    plan_set: true,
    goal: pendingGoal.goal.objective,
    steps: pendingPlan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      ...(s.tool ? { tool: s.tool } : {}),
      effects: s.expectedEffects.length,
      ...(done.has(s.id) ? { already_executed: true } : {}),
    })),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Compact baseline summary for the set_goal tool result — the model reads
 * these numbers when picking thresholds. With Scale Mode on, Live's declared
 * scale is stronger evidence than the detected key and rides as liveScale;
 * offKeyPct gives in_key/off_key_lte goals their measured starting point. */
function summarizeView(v: GoalView): Record<string, unknown> {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    tempo: v.tempo,
    key: v.keyBest ?? null,
    liveScale: v.liveScale.mode
      ? { root: pcName(v.liveScale.root), name: v.liveScale.name, intervals: v.liveScale.intervals }
      : null,
    offKeyPct: v.offKeyRatio !== undefined ? r2(v.offKeyRatio * 100) : null,
    trackCount: v.trackCount,
    sections: v.sections.map((s) => ({ name: s.name, bars: s.bars, density: r2(s.density), tracks: s.tracks })),
  };
}

export async function handleSetGoal(context: Ctx, input: Record<string, unknown>): Promise<unknown> {
  const norm = normalizeGoal(input);
  if (!norm.goal) {
    throw new Error(
      `set_goal 未生效：没有有效的 successCriteria/constraints。` +
        (norm.warnings.length ? ` ${norm.warnings.join("；")}` : ""),
    );
  }
  const late = mutationsThisTurn > 0;
  const warnings = [...norm.warnings];
  // PR16: an optional reference track rides the goal as comparison evidence.
  // Parsed BEFORE the baseline block so audio enrichment covers a reference
  // comparison too (gaps on audio metrics need the current side decoded).
  const refInput = input.reference as { path?: unknown; section?: unknown; tempo_bpm?: unknown } | undefined;
  const referencePath =
    typeof refInput?.path === "string" && refInput.path.trim() ? refInput.path.trim() : undefined;
  const referencePinned =
    typeof refInput?.section === "string" && refInput.section.trim() ? refInput.section.trim() : undefined;
  const referenceTempo =
    typeof refInput?.tempo_bpm === "number" && refInput.tempo_bpm > 0 ? refInput.tempo_bpm : undefined;
  if (late && !pendingGoal) {
    warnings.push(
      `注意：本回合已有 ${mutationsThisTurn} 次改动先于 set_goal 执行，基线捕获的是改动后的状态 — set_goal 应在任何修改类工具之前调用。`,
    );
  }
  if (pendingPlan) {
    // The goal the plan was built for just changed — the old plan is stale.
    pendingPlan = null;
    warnings.push(`目标已重新声明，之前的计划已清除 — 请重新调用 set_plan。`);
  }
  // Audio criteria judge clip source files: decode them before capturing the
  // baseline so the after-view compares like with like. Cache makes the
  // goalGate re-run nearly free.
  let held = pendingGoal ? { baseline: pendingGoal.baseline, intel: pendingGoal.intel } : null;
  if (!held) {
    const state = buildMusicState(buildSongSnapshot(context.application.song));
    if (goalNeedsAudio(norm.goal) || referencePath) await enrichMusicStateWithAudio(state);
    // Chain the music/ stack over the SAME state the baseline view measures.
    // Roles come from the interpretation layer so a role-named goal resolves
    // against the very labels role_present will judge. Audio features stay
    // undefined unless the goal already needed decoding — the honesty rules
    // carry that through to the projection.
    const baseline = buildGoalView(state);
    // gen_* criteria judge the registry, not the Set: the latest record at
    // declaration time is the "previous iteration" gen_improved_vs_prev
    // compares against. Anchored here so a re-declared goal keeps it.
    if (goalNeedsGenlog(norm.goal)) attachLatestGeneration(baseline);
    held = {
      baseline,
      intel: buildMusicIntelligence(state, analyzeMusicState(state)),
    };
  }
  const prevGoal = pendingGoal;
  pendingGoal = {
    goal: norm.goal,
    // Re-declaring within one turn refines the criteria but keeps the
    // ORIGINAL baseline — "what the user asked for this turn" is anchored at
    // the first declaration.
    baseline: held.baseline,
    intel: held.intel,
    // A re-declare without a reference field keeps the previous reference;
    // an explicit new path replaces it below.
    ...(prevGoal?.referenceAnalysis !== undefined ? { referenceAnalysis: prevGoal.referenceAnalysis } : {}),
    ...(prevGoal?.referenceError !== undefined ? { referenceError: prevGoal.referenceError } : {}),
    ...(prevGoal?.referencePinnedSectionId !== undefined
      ? { referencePinnedSectionId: prevGoal.referencePinnedSectionId }
      : {}),
    retries: prevGoal?.retries ?? 0,
    refinements: prevGoal?.refinements ?? 0,
    lateBaseline: prevGoal?.lateBaseline ?? late,
  };
  // Reference: load/analyze once (process cache), store on the goal — the
  // gate re-derives gaps against the after-state WITHOUT re-decoding (§60).
  // A failure degrades to a warning; the plain goal flow is untouched (§62).
  if (referencePath) {
    const outcome = loadReferenceAnalysis(referencePath, referenceTempo);
    if ("analysis" in outcome) {
      pendingGoal.referenceAnalysis = outcome.analysis;
      pendingGoal.referenceError = undefined;
      pendingGoal.referencePinnedSectionId = referencePinned;
      toolHooks.debugLog(
        context,
        `REFERENCE analyzed (v${REFERENCE_ANALYZER_VERSION}): ${referencePath}` +
          ` · sections=${outcome.analysis.sections.length} tempo=${outcome.analysis.tempo?.value ?? "?"}` +
          (outcome.analysis.partial ? " · PARTIAL" : ""),
      );
    } else {
      pendingGoal.referenceAnalysis = undefined;
      pendingGoal.referenceError = outcome.error;
      pendingGoal.referencePinnedSectionId = undefined;
      warnings.push(
        `参考音频不可用（${outcome.error}${outcome.message ? `: ${outcome.message}` : ""}）— 目标校验将不使用参考对比，其余流程不受影响。`,
      );
      toolHooks.debugLog(context, `REFERENCE ${outcome.error}: ${referencePath}${outcome.message ? ` · ${outcome.message}` : ""}`);
    }
  }
  // The planner's evidence: the goal's projected slice of the music/ stack,
  // riding the tool result so set_plan is written against measured numbers.
  // Re-declares re-project the STORED intelligence against the NEW goal —
  // the baseline stays anchored, the focus follows the current goal. An
  // intelligence bug must never sink a working goal declaration.
  let music: Record<string, unknown> | undefined;
  try {
    music = presentGoalContext(projectGoalContext(pendingGoal.intel, norm.goal));
  } catch (err) {
    toolHooks.debugLog(context, `INTEL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // PR15: resolve the goal's target SECTION and hand the planner a bounded
  // context (target + comparison references + only the relevant features/
  // observations/actions). Unresolved targets stay absent — the song-level
  // music block above is the fallback, never a fabricated section.
  let section: Record<string, unknown> | undefined;
  let reference: Record<string, unknown> | undefined;
  try {
    let sctx = buildSectionPlanningContext(norm.goal, pendingGoal.intel);
    // PR16: with a reference on the goal, derive the comparison against the
    // RESOLVED target (alignment → gaps → conservative actions) and rebuild
    // the context so the reference block rides it. No alignment → no block.
    if (sctx && pendingGoal.referenceAnalysis) {
      const refIntel = buildReferenceIntelligence(
        pendingGoal.referenceAnalysis,
        pendingGoal.intel.features.sections,
        {
          targetSectionId: sctx.target.sectionId,
          ...(pendingGoal.referencePinnedSectionId
            ? { referenceSectionId: pendingGoal.referencePinnedSectionId }
            : {}),
        },
      );
      sctx = buildSectionPlanningContext(norm.goal, { ...pendingGoal.intel, reference: refIntel }) ?? sctx;
      if (sctx.reference) {
        reference = presentReferencePlanningContext(sctx.reference);
        const meaningful = sctx.reference.gaps.filter(
          (g) => g.direction === "higher_in_reference" || g.direction === "lower_in_reference",
        );
        toolHooks.debugLog(
          context,
          `REFERENCE aligned: ${sctx.target.name} → ${sctx.reference.referenceSectionId}` +
            (meaningful.length
              ? ` · gaps=${meaningful.map((g) => `${g.metric}${g.delta !== undefined ? (g.delta >= 0 ? "+" : "") + g.delta : ""}`).join(",")}`
              : " · no meaningful gaps") +
            (sctx.reference.actions.length
              ? ` · actions=${sctx.reference.actions.map((a) => a.kind).join(",")}`
              : ""),
        );
      } else {
        toolHooks.debugLog(context, `REFERENCE no alignment: ${sctx.target.name} — reference block omitted`);
      }
    }
    if (sctx) {
      pendingGoal.section = sctx;
      section = presentSectionPlanningContext(sctx);
      toolHooks.debugLog(
        context,
        `SECTION target: ${sctx.target.name} (id=${sctx.target.sectionId}, match=${sctx.target.match}, conf=${sctx.target.confidence})` +
          (sctx.references.length
            ? ` · refs=${sctx.references.map((r) => `${r.name}(${r.reason})`).join(",")}`
            : ""),
      );
    } else {
      pendingGoal.section = undefined;
      if (norm.goal.target?.section) {
        toolHooks.debugLog(context, `SECTION unresolved: 「${norm.goal.target.section}」 — falling back to song-level context`);
      }
    }
  } catch (err) {
    pendingGoal.section = undefined;
    toolHooks.debugLog(context, `SECTION failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  toolHooks.debugLog(
    context,
    `GOAL set (${norm.goal.type}): ${norm.goal.objective} · criteria=${norm.goal.successCriteria.length} constraints=${norm.goal.constraints.length}`,
  );
  return {
    goal_set: true,
    type: norm.goal.type,
    objective: norm.goal.objective,
    criteria: norm.goal.successCriteria.length,
    constraints: norm.goal.constraints.length,
    baseline: summarizeView(pendingGoal.baseline),
    ...(music ? { music } : {}),
    ...(section ? { section } : {}),
    ...(reference ? { reference } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

type GoalGateResult = { inject: string } | { appendNote: string } | null;

const GOAL_RETRY_TAIL: Record<string, string> = {
  zh: "请继续调用工具直到标准满足；若确实无法满足，向用户如实说明卡在哪一步。禁止在标准未满足时声称已完成。 / Keep working until the criteria pass, or tell the user honestly what is blocking you — do NOT claim completion while they are unmet.",
  en: "Keep working until the criteria pass, or tell the user honestly what is blocking you — do NOT claim completion while they are unmet.",
};

/** Plan diagnosis appended to goal-gate messages: which steps never ran and
 * which predicted effects didn't materialize — the retry's self-correction
 * target. Empty when the plan fully executed and every effect was observed. */
function planDiagnosisLines(report: PlanReport): string[] {
  const lines: string[] = [];
  const unexecuted = report.unexecuted.map(
    (s) => `${s.id}「${s.description}」${s.tool ? ` (${s.tool})` : ""}`,
  );
  if (unexecuted.length) lines.push(`计划中未执行的步骤：${unexecuted.join("；")}`);
  const missed = report.unobserved.map(
    (fx) => `${fx.stepId}「${fx.description}」: 期望 ${fx.expected}${fx.actual ? `，实际 ${fx.actual}` : ""}`,
  );
  if (missed.length) lines.push(`预期效果未观察到：${missed.join("；")}`);
  if (lines.length) lines.unshift(`【计划诊断 / Plan】已执行 ${report.executedCount}/${report.total} 步：`);
  return lines;
}

/** PR15 section verdict as retry-message lines lives in the sections layer
 * (presentSectionVerification) — the retry's self-correction surface is the
 * layer's own presentation, tested with the layer. */
function goalRetryMessage(
  goal: MusicGoal,
  ev: GoalEvaluation,
  retries: number,
  language?: string,
  plan?: PlanReport,
  replanned?: boolean,
  sectionVer?: SectionVerification,
  sectionName?: string,
  referenceLines?: string[],
): string {
  const lines: string[] = [
    `【目标校验 / Goal check】第 ${retries}/${AGENT_MAX_RETRIES} 次校验，目标「${goal.objective}」尚未达成：`,
  ];
  if (ev.constraintIssues.length) lines.push(`约束违反：${ev.constraintIssues.join("；")}`);
  if (ev.criteriaIssues.length) lines.push(`未达成标准：${ev.criteriaIssues.join("；")}`);
  if (plan) lines.push(...planDiagnosisLines(plan));
  if (sectionVer && sectionName) lines.push(...presentSectionVerification(sectionVer, sectionName));
  if (referenceLines?.length) lines.push(...referenceLines);
  if (replanned) {
    // The loop's single retry IS the replan: the old route already missed, so
    // it is cleared rather than re-run. A fresh focused plan is invited, not
    // required — a one-call fix may go directly.
    lines.push(
      `原计划已清除 — 请根据以上诊断重新声明一个聚焦剩余差距的 set_plan（差距很小也可直接修复）。` +
        ` / The previous plan has been cleared — re-declare a focused set_plan for the remaining gap (or fix it directly if small).`,
    );
  }
  lines.push(GOAL_RETRY_TAIL[language ?? ""] ?? GOAL_RETRY_TAIL.zh);
  return lines.join("\n");
}

/** Compact diff of the last two registry records — "what the previous
 * refinement actually changed", so the next prompt edit is attributable. */
function lastIterationDiffLines(): string[] {
  const records = loadGenLog();
  if (records.length < 2) return [];
  const diff = diffGenerations(records[records.length - 2], records[records.length - 1]);
  const entries = Object.entries(diff.metrics)
    .filter(([, e]) => e !== undefined && Math.abs(e.delta) > 1e-9)
    .sort((a, b) => Math.abs(b[1]!.delta) - Math.abs(a[1]!.delta))
    .slice(0, 6);
  if (!entries.length) return [];
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  return [
    `上一轮迭代变化（${diff.from} → ${diff.to}）：` +
      entries.map(([m, e]) => `${m} ${fmt(e!.before)}→${fmt(e!.after)}（Δ ${e!.delta > 0 ? "+" : ""}${fmt(e!.delta)}）`).join("，"),
  ];
}

/** PR19 refine injection: the failed gen_* checks, deterministic parameter
 * hints, and the last iteration's diff. The plan is intentionally NOT
 * cleared — the route was fine, the artifact wasn't. */
function goalRefineMessage(
  goal: MusicGoal,
  ev: GoalEvaluation,
  genGaps: GenGap[],
  refinements: number,
): string {
  const lines: string[] = [
    `【生成迭代 / Generation refine】第 ${refinements}/${AGENT_MAX_REFINEMENTS} 次迭代 — 目标「${goal.objective}」的生成产物尚未达标：`,
  ];
  const genIssues = [...ev.constraintIssues, ...ev.criteriaIssues].filter((i) => i.startsWith("gen."));
  if (genIssues.length) lines.push(`未达成：${genIssues.join("；")}`);
  if (refinements > 1) lines.push(...lastIterationDiffLines());
  lines.push(`调整建议：${genGaps.map((g) => suggestForGenGap(g)).join("；")}`);
  lines.push(REFINE_DISCIPLINE);
  lines.push(
    `请用调整后的 prompt 再次调用 generate_audio（建议带 importTo 直接上轨）。剩余迭代预算：${AGENT_MAX_REFINEMENTS - refinements} 次。` +
      (toolHooks.getAudioAutoRefine()
        ? ""
        : `（autoRefine 未开启，每次生成仍需你确认 — 可在 设置 → 音频生成 里打开自动迭代）`),
  );
  return lines.join("\n");
}

/** PR20 finding: the relay can HALLUCINATE a failure narrative (it imitated
 * the unmet note's exact format with fabricated numbers). On a real pass the
 * gate previously appended nothing, leaving the model's text as the only
 * verdict the user saw. The measured pass now always lands as a system line
 * with the actual numbers, so a fabricated failure is visibly contradicted. */
function goalMetNote(ev: GoalEvaluation, language?: string): string {
  const zh = (language ?? "").startsWith("zh") || !language;
  const head = zh ? "\n\n✅ 目标校验通过（系统实测）：" : "\n\n✅ Goal check passed (server-measured): ";
  const passed = ev.checks
    .filter((c) => c.passed)
    .map((c) => `${c.id}${c.actual ? ` = ${c.actual}` : ""}`)
    .join("；");
  const tail = zh ? "。以系统实测为准。" : ". Trust this over any text above.";
  return `${head}${passed || "—"}${tail}`;
}

const GOAL_UNMET_NOTE: Record<string, string> = {
  zh: `\n\n⚠️ 目标校验未通过（系统已重试 ${AGENT_MAX_RETRIES} 次）：`,
  en: `\n\n⚠️ Goal check failed (retried ${AGENT_MAX_RETRIES}× by the server): `,
};

function goalUnmetNote(
  ev: GoalEvaluation,
  language?: string,
  plan?: PlanReport,
  sectionVer?: SectionVerification,
  sectionName?: string,
  referenceLines?: string[],
): string {
  const head = GOAL_UNMET_NOTE[language ?? ""] ?? GOAL_UNMET_NOTE.zh;
  const issues = [...ev.constraintIssues, ...ev.criteriaIssues].join("；");
  const planLines = plan ? planDiagnosisLines(plan) : [];
  if (sectionVer && sectionName) planLines.push(...presentSectionVerification(sectionVer, sectionName));
  if (referenceLines?.length) planLines.push(...referenceLines);
  const tail =
    (language ?? "").startsWith("zh") || !language
      ? "。以上为系统对 Live Set 的实际检测结果，与上文表述如有出入以检测结果为准。"
      : ". This is the server's measured state of the Live Set — trust it over the text above.";
  return `${head}${issues}${planLines.length ? `\n${planLines.join("\n")}` : ""}${tail}`;
}

/** Evaluate the pending goal at a loop's text-exit. Returns what the loop
 * should do: inject a retry message and continue, or append a note and
 * finish. Never throws — a goal-layer bug must not break a working chat. */
export async function goalGate(context: Ctx, language?: string): Promise<GoalGateResult> {
  const held = pendingGoal;
  if (!held) return null;
  try {
    // Rebuild the after-view against the current Set; when the goal (or a
    // plan built on it) judges source-file audio, decode first — the feature
    // cache makes this nearly free after the set_goal baseline run.
    const afterState = buildMusicState(buildSongSnapshot(context.application.song));
    if (goalNeedsAudio(held.goal) || (pendingPlan && planNeedsAudio(pendingPlan)) || held.referenceAnalysis) {
      await enrichMusicStateWithAudio(afterState);
    }
    const after = buildGoalView(afterState);
    if (goalNeedsGenlog(held.goal)) attachLatestGeneration(after);
    const ev = evaluateGoal(held.goal, held.baseline, after);
    // Plan diagnosis rides the SAME before/after views, so a plan effect and
    // a goal criterion can never disagree about the numbers. The plan never
    // gates: a met goal clears it silently (debugLog only).
    const plan = pendingPlan
      ? buildPlanReport(pendingPlan, executedToolsThisTurn, held.baseline, after)
      : null;
    // PR15: when the goal resolved a target section, re-analyze THAT section
    // and judge the before/after change against goal-aware criteria. One
    // extra intelligence chain per gate (§77: before once, after once — never
    // per tool call). The goal gate stays the final authority; this verdict
    // is EVIDENCE for the retry message, not a second gate. A section-layer
    // bug must never sink the gate.
    let sectionVer: SectionVerification | undefined;
    let referenceLines: string[] = [];
    if (held.section) {
      try {
        const afterIntel = buildMusicIntelligence(afterState, analyzeMusicState(afterState));
        sectionVer = verifySectionChange(held.section, held.intel, afterIntel, held.goal);
        // PR16: re-derive the reference gaps against the after-state — the
        // CACHED analysis is reused (never re-decoded, §60) and gap
        // REDUCTION is judged as evidence. The goal gate stays the
        // authority: reference lines inform the retry, they never gate it.
        if (held.section.reference && held.referenceAnalysis && sectionVer.target.afterSectionId) {
          const afterTargetId = sectionVer.target.afterSectionId;
          const refIntelAfter = buildReferenceIntelligence(
            held.referenceAnalysis,
            afterIntel.features.sections,
            {
              targetSectionId: afterTargetId,
              ...(held.referencePinnedSectionId
                ? { referenceSectionId: held.referencePinnedSectionId }
                : {}),
            },
          );
          const afterRefCtx = buildReferencePlanningContext(
            { ...held.section.target, sectionId: afterTargetId },
            afterIntel.features.sections,
            refIntelAfter,
          );
          if (afterRefCtx) {
            referenceLines = presentReferenceVerification(
              verifyReferenceProgress(held.section.reference, afterRefCtx),
            );
          }
        }
      } catch (err) {
        toolHooks.debugLog(context, `SECTION verify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The loop's exit decision is one pure function (agent/loop.ts) — pass,
    // refine, retry once, or stop. A retry/refine with no mutation budget
    // left is a stop: it could only re-analyze and apologize.
    const left = mutationsLeft(executedToolsThisTurn, READ_ONLY_TOOLS);
    // PR19 refine eligibility: a gen_* criterion failed AND there is an
    // analyzable artifact to improve on. ev.checks aligns index-for-index
    // with constraints-then-criteria (evaluateGoal's construction), so the
    // gap direction comes straight from the failed criterion.
    const genGaps: GenGap[] = [];
    [...held.goal.constraints, ...held.goal.successCriteria].forEach((c, i) => {
      if (ev.checks[i]?.passed !== false) return;
      if (c.kind === "gen_metric_gte") {
        genGaps.push({ metric: c.metric, ...(c.band ? { band: c.band } : {}), direction: "up" });
      } else if (c.kind === "gen_improved_vs_prev") {
        genGaps.push({ metric: c.metric, ...(c.band ? { band: c.band } : {}), direction: c.direction });
      }
    });
    const refine = {
      available:
        genGaps.length > 0 &&
        after.latestGeneration?.features !== undefined &&
        refineHasNewArtifact(after.latestGeneration?.id, held.refineSeenGenId),
      used: held.refinements,
    };
    const action = gateAction(ev.met, held.retries, left, refine);
    if (action === "pass") {
      pendingGoal = null;
      pendingPlan = null;
      toolHooks.debugLog(
        context,
        `GOAL MET: ${held.goal.objective}` +
          (plan ? ` · plan ${plan.executedCount}/${plan.total} steps` : "") +
          (sectionVer ? ` · section ${sectionVer.status}` : ""),
      );
      return { appendNote: goalMetNote(ev, language) };
    }
    toolHooks.debugLog(
      context,
      `GOAL UNMET (${held.retries + 1}/${AGENT_MAX_RETRIES + 1}): ${[...ev.constraintIssues, ...ev.criteriaIssues].join("；")}` +
        (plan
          ? ` · plan: ${plan.unexecuted.length} steps unexecuted, ${plan.unobserved.length} effects unobserved`
          : "") +
        (action === "stop" && left <= 0 && held.retries < AGENT_MAX_RETRIES
          ? ` · mutation budget exhausted (${AGENT_MAX_STEPS}) — no retry`
          : ""),
    );
    if (action === "stop") {
      pendingGoal = null;
      pendingPlan = null;
      return {
        appendNote: goalUnmetNote(ev, language, plan ?? undefined, sectionVer, held.section?.target.name, referenceLines),
      };
    }
    if (action === "refine") {
      // A refine is NOT a retry: the plan executed, the artifact missed — so
      // the plan and the retry counter stay untouched, and the injection is
      // the iteration diff + deterministic parameter hints, not a replan
      // diagnosis.
      held.refinements++;
      held.refineSeenGenId = after.latestGeneration?.id;
      toolHooks.debugLog(
        context,
        `GOAL REFINE (${held.refinements}/${AGENT_MAX_REFINEMENTS}): ${genGaps.map((g) => g.metric).join(", ")}`,
      );
      return { inject: goalRefineMessage(held.goal, ev, genGaps, held.refinements) };
    }
    held.retries++;
    // The single retry IS the replan: the old route already missed, so clear
    // it — the model re-declares a focused plan from the diagnosis (or fixes
    // directly). The report was computed above, before the clear. The section
    // verdict rides along so the retry sees which target-section metric
    // missed and by how much — the target itself is NOT re-resolved (target
    // stability across retry).
    const replanned = pendingPlan !== null;
    pendingPlan = null;
    return {
      inject: goalRetryMessage(
        held.goal,
        ev,
        held.retries,
        language,
        plan ?? undefined,
        replanned,
        sectionVer,
        held.section?.target.name,
        referenceLines,
      ),
    };
  } catch (err) {
    pendingGoal = null;
    pendingPlan = null;
    toolHooks.debugLog(context, `GOAL gate skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function callTool(
  context: Ctx,
  actions: { tool: string; input: unknown; result: unknown }[],
  name: string,
  input: Record<string, unknown>,
  yolo: boolean,
): Promise<string> {
  // Agent-loop step budget (agent/loop.ts): once AGENT_MAX_STEPS mutations
  // actually executed this turn, further mutating calls are refused BEFORE
  // running — and before the user is asked to confirm. The refusal never
  // enters executedToolsThisTurn (it didn't execute), so the budget can't be
  // talked past; the model must wrap up and let the user say "continue".
  if (
    !READ_ONLY_TOOLS.has(name) &&
    countMutations(executedToolsThisTurn, READ_ONLY_TOOLS) >= AGENT_MAX_STEPS
  ) {
    const refused = stepBudgetError();
    actions.push({ tool: name, input, result: refused });
    toolHooks.debugLog(context, `TOOL ${name} REFUSED: mutation budget ${AGENT_MAX_STEPS} exhausted`);
    return JSON.stringify(refused);
  }
  // Costly tools confirm even under YOLO — EXCEPT generate_audio inside an
  // active refine loop when the user turned autoRefine on: the refinement
  // budget (AGENT_MAX_REFINEMENTS) is the pre-authorized spend limit, and a
  // per-call dialog would defeat unattended iteration. Outside a refine —
  // or with autoRefine off — every generation still asks.
  const refinePreAuthorized =
    COSTLY_TOOLS.has(name) &&
    toolHooks.getAudioAutoRefine() &&
    (pendingGoal?.refinements ?? 0) > 0;
  const needsConfirm =
    !READ_ONLY_TOOLS.has(name) && !refinePreAuthorized && (!yolo || COSTLY_TOOLS.has(name));
  if (needsConfirm) {
    const allowed = await askConfirmation(name, input);
    if (!allowed) {
      const denied = { error: "用户拒绝了该操作 / user denied this action" };
      actions.push({ tool: name, input, result: denied });
      toolHooks.debugLog(context, `TOOL ${name} DENIED by user`);
      return JSON.stringify(denied);
    }
  }
  let result: unknown;
  try {
    result = await runTool(context, name, input);
    // Plan-layer step matching counts every call that actually ran — a call
    // whose verify later fails still executed ("missed target" ≠ "never
    // happened"); the step's effect check carries that diagnosis instead.
    if (!PLAN_META_TOOLS.has(name)) executedToolsThisTurn.push(name);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  result = await verifyToolResult(context, name, input, result);
  // Count executed mutations so a set_goal declared mid-turn can flag that
  // its baseline is already post-change (handleSetGoal's late warning).
  if (
    !READ_ONLY_TOOLS.has(name) &&
    !(result !== null && typeof result === "object" && "error" in result)
  ) {
    mutationsThisTurn++;
  }
  actions.push({ tool: name, input, result });
  const resultJson = JSON.stringify(result);
  toolHooks.debugLog(context, `TOOL ${name} ${JSON.stringify(input)} -> ${resultJson.slice(0, 400)}`);
  return truncateResult(resultJson);
}

/** Reset the per-turn goal/plan/mutation bookkeeping — called by chat() at
 * the start of every user turn so a stale goal never gates a new request. */
export function resetTurnState(): void {
  pendingGoal = null;
  pendingPlan = null;
  mutationsThisTurn = 0;
  executedToolsThisTurn = [];
}

// Self-register the set_goal/set_plan tool handlers (dispatcher calls these
// through toolHooks at request time).
toolHooks.handleSetGoal = handleSetGoal;
toolHooks.handleSetPlan = handleSetPlan;
