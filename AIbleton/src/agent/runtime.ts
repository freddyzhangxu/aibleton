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
  AGENT_MAX_CONSECUTIVE_TOOL_ERRORS,
  AGENT_MAX_REFINEMENTS,
  AGENT_MAX_RETRIES,
  countMutations,
  gateAction,
  mutationsLeft,
  nextToolErrorState,
  refineHasNewArtifact,
  stepBudgetError,
  AGENT_MAX_STEPS,
  type ConsecutiveToolErrorState,
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
import { goalIssue, goalText, normalizeGoalLanguage } from "../goal/i18n.js";
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
  refineDiscipline,
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
import { listenHintFor } from "../tools/listenhint.js";
import { buildSongSnapshot } from "../tools/helpers.js";
import { resolvedSelection } from "../setcontext.js";
import { selectionGuard } from "../selectionguard.js";
import {
  askConfirmation,
  COSTLY_TOOLS,
  READ_ONLY_TOOLS,
  verifyToolResult,
} from "../chat/gates.js";
import {
  deleteAuthorizationError,
  deleteToolIsAuthorized,
  isDeleteTool,
} from "../chat/deleteauth.js";
import * as fs from "node:fs";
import { actionableError, friendlyToolError, sanitizeToolResultLanguage } from "../errors.js";
import { toolHooks, toolState, type Ctx } from "../state.js";
import { truncateResult } from "../chat/session.js";
import { clearTurnGoalOutcome, setTurnGoalOutcome } from "./turnoutcome.js";
import { commonText } from "../i18n/common.js";

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
  outcome: Promise<{ analysis: ReferenceAnalysis } | { error: ReferenceError; message?: string }>;
}

const referenceCache = new Map<string, ReferenceCacheEntry>();

export async function loadReferenceAnalysis(
  path: string,
  tempoBpm?: number,
): Promise<Awaited<ReferenceCacheEntry["outcome"]>> {
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
    return await hit.outcome;
  }
  const buf = readHomeBinary(path);
  if (!buf) {
    const outcome = { error: "reference_unavailable" as const, message: "unreadable (missing or denied)" };
    referenceCache.set(path, { mtimeMs, size: size ?? 0, outcome: Promise.resolve(outcome) });
    return outcome;
  }
  const source: ReferenceSource = { type: "audio_file", path };
  const outcome = analyzeReferenceBuffer(source, buf, { ...(tempoBpm !== undefined ? { tempoBpm } : {}) });
  if (tempoBpm === undefined) {
    referenceCache.set(path, { mtimeMs, size: buf.length, outcome });
  }
  return await outcome;
}


/** Mutating calls that actually executed this turn (drives lateBaseline). */
let mutationsThisTurn = 0;
let consecutiveToolErrors: ConsecutiveToolErrorState = { count: 0 };

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

function localizedNormalizationWarnings(
  warnings: string[],
  kind: "invalidGoalWarning" | "invalidPlanWarning",
): string[] {
  if (!warnings.length) return [];
  if (toolState.activeLanguage === "zh") return warnings;
  return [commonText(toolState.activeLanguage, kind)];
}

export function handleSetPlan(context: Ctx, input: Record<string, unknown>): unknown {
  if (!pendingGoal) {
    throw actionableError(commonText(toolState.activeLanguage, "planRequiresGoal"));
  }
  const norm = normalizePlan(input, VALID_TOOL_NAMES);
  if (!norm.steps) {
    throw actionableError(commonText(toolState.activeLanguage, "planNoValidSteps"));
  }
  const warnings = localizedNormalizationWarnings(norm.warnings, "invalidPlanWarning");
  if (mutationsThisTurn > 0) {
    warnings.push(commonText(toolState.activeLanguage, "planDeclaredLate", mutationsThisTurn));
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
    throw actionableError(commonText(toolState.activeLanguage, "goalNoValidCriteria"));
  }
  const late = mutationsThisTurn > 0;
  const warnings = localizedNormalizationWarnings(norm.warnings, "invalidGoalWarning");
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
    warnings.push(commonText(toolState.activeLanguage, "goalDeclaredLate", mutationsThisTurn));
  }
  if (pendingPlan) {
    // The goal the plan was built for just changed — the old plan is stale.
    pendingPlan = null;
    warnings.push(commonText(toolState.activeLanguage, "goalRedeclared"));
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
    const outcome = await loadReferenceAnalysis(referencePath, referenceTempo);
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
      warnings.push(commonText(toolState.activeLanguage, "referenceUnavailable", outcome.error));
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

/** Plan diagnosis appended to goal-gate messages: which steps never ran and
 * which predicted effects didn't materialize — the retry's self-correction
 * target. Empty when the plan fully executed and every effect was observed. */
function planDiagnosisLines(report: PlanReport, language?: string): string[] {
  const lines: string[] = [];
  const unexecuted = report.unexecuted.map(
    (s) => `${s.id}「${s.description}」${s.tool ? ` (${s.tool})` : ""}`,
  );
  if (unexecuted.length) lines.push(goalText(language, "unexecutedSteps", unexecuted.join("; ")));
  const missed = report.unobserved.map(
    (fx) => goalIssue(language, `${fx.stepId} "${fx.description}"`, fx.expected, fx.actual),
  );
  if (missed.length) lines.push(goalText(language, "unobservedEffects", missed.join("; ")));
  if (lines.length) lines.unshift(goalText(language, "planDiagnosis", report.executedCount, report.total));
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
    goalText(language, "goalRetry", retries, AGENT_MAX_RETRIES, goal.objective),
  ];
  if (ev.constraintIssues.length) lines.push(goalText(language, "constraintViolations", ev.constraintIssues.join("; ")));
  if (ev.criteriaIssues.length) lines.push(goalText(language, "unmetCriteria", ev.criteriaIssues.join("; ")));
  if (plan) lines.push(...planDiagnosisLines(plan, language));
  if (sectionVer && sectionName) lines.push(...presentSectionVerification(sectionVer, sectionName, language));
  if (referenceLines?.length) lines.push(...referenceLines);
  if (replanned) {
    // A loop retry can replan: the old route already missed, so
    // it is cleared rather than re-run. A fresh focused plan is invited, not
    // required — a one-call fix may go directly.
    lines.push(goalText(language, "planCleared"));
  }
  lines.push(goalText(language, "retryInstruction"));
  return lines.join("\n");
}

/** Compact diff of the last two registry records — "what the previous
 * refinement actually changed", so the next prompt edit is attributable. */
function lastIterationDiffLines(language?: string): string[] {
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
    goalText(language, "previousIteration", diff.from, diff.to) + " " +
      entries.map(([m, e]) => `${m} ${fmt(e!.before)}→${fmt(e!.after)} (Δ ${e!.delta > 0 ? "+" : ""}${fmt(e!.delta)})`).join(", "),
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
  language?: string,
): string {
  const lines: string[] = [
    goalText(language, "generationRefine", refinements, AGENT_MAX_REFINEMENTS, goal.objective),
  ];
  const genIssues = [...ev.constraintIssues, ...ev.criteriaIssues].filter((i) => i.startsWith("gen."));
  if (genIssues.length) lines.push(goalText(language, "generationUnmet", genIssues.join("; ")));
  if (refinements > 1) lines.push(...lastIterationDiffLines(language));
  lines.push(goalText(language, "adjustmentSuggestions", genGaps.map((g) => suggestForGenGap(g, language)).join("; ")));
  lines.push(refineDiscipline(language));
  lines.push(
    goalText(language, "generateAgain", AGENT_MAX_REFINEMENTS - refinements) +
      (toolHooks.getAudioAutoRefine()
        ? ""
        : goalText(language, "autoRefineOff")),
  );
  return lines.join("\n");
}

function goalOutcomeSummary(ev: GoalEvaluation, met: boolean): string | undefined {
  if (met) {
    const passed = ev.checks
      .filter((c) => c.passed)
      .map((c) => `${c.id}${c.actual ? ` = ${c.actual}` : ""}`)
      .join("; ");
    return passed || undefined;
  }
  const issues = [...ev.constraintIssues, ...ev.criteriaIssues].join("; ");
  return issues || undefined;
}

function goalUnmetNote(
  ev: GoalEvaluation,
  language?: string,
  plan?: PlanReport,
  sectionVer?: SectionVerification,
  sectionName?: string,
  referenceLines?: string[],
): string {
  const head = goalText(language, "goalFailed", AGENT_MAX_RETRIES);
  const issues = [...ev.constraintIssues, ...ev.criteriaIssues].join("; ");
  const planLines = plan ? planDiagnosisLines(plan, language) : [];
  if (sectionVer && sectionName) planLines.push(...presentSectionVerification(sectionVer, sectionName, language));
  if (referenceLines?.length) planLines.push(...referenceLines);
  const tail = goalText(language, "trustMeasuredFailure");
  return `${head}${issues}${planLines.length ? `\n${planLines.join("\n")}` : ""}${tail}`;
}

/** Evaluate the pending goal at a loop's text-exit. Returns what the loop
 * should do: inject a retry message and continue, or append a note and
 * finish. Never throws — a goal-layer bug must not break a working chat. */
export async function goalGate(context: Ctx, language?: string): Promise<GoalGateResult> {
  const held = pendingGoal;
  if (!held) return null;
  const locale = normalizeGoalLanguage(language);
  // The gate re-measures the Set (and may decode clip audio) — that work is
  // "analyzing" from the user's seat, not idle thinking.
  toolState.phase = "analyzing";
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
    const ev = evaluateGoal(held.goal, held.baseline, after, locale);
    // Plan diagnosis rides the SAME before/after views, so a plan effect and
    // a goal criterion can never disagree about the numbers. The plan never
    // gates: a met goal clears it silently (debugLog only).
    const plan = pendingPlan
      ? buildPlanReport(pendingPlan, executedToolsThisTurn, held.baseline, after, locale)
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
              locale,
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
      const verification = goalOutcomeSummary(ev, true);
      setTurnGoalOutcome({
        status: "passed",
        objective: held.goal.objective,
        ...(verification ? { verification } : {}),
      });
      pendingGoal = null;
      pendingPlan = null;
      toolHooks.debugLog(
        context,
        `GOAL MET: ${held.goal.objective}` +
          (plan ? ` · plan ${plan.executedCount}/${plan.total} steps` : "") +
          (sectionVer ? ` · section ${sectionVer.status}` : ""),
      );
      // The structured turn outcome and task receipt already carry the
      // measured pass. Keep internal criterion IDs and role aggregates out
      // of the user-facing chat reply.
      return null;
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
      const verification = goalOutcomeSummary(ev, false);
      setTurnGoalOutcome({
        status: "unmet",
        objective: held.goal.objective,
        ...(verification ? { verification } : {}),
      });
      pendingGoal = null;
      pendingPlan = null;
      return {
        appendNote: goalUnmetNote(ev, locale, plan ?? undefined, sectionVer, held.section?.target.name, referenceLines),
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
      return { inject: goalRefineMessage(held.goal, ev, genGaps, held.refinements, locale) };
    }
    held.retries++;
    // This retry can replan: the old route already missed, so clear
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
        locale,
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
  } finally {
    toolState.phase = "thinking";
  }
}

/** UI phase per tool (toolState.phase → /api/status → the thinking bubble).
 * Only long-feeling tools are named explicitly; the rest fall back by kind —
 * reads are "reading", mutations "applying". The string is an i18n KEY the
 * UI localizes, never user-facing text itself. */
const TOOL_PHASES: Record<string, string> = {
  generate_audio: "generating",
  analyze_song: "analyzing",
  analyze_rendered_track: "rendering",
  move_analyze_set: "analyzing",
  set_goal: "planning",
  set_plan: "planning",
  web_search: "searching",
  web_fetch: "searching",
  search_samples: "searching",
};

function phaseForTool(name: string): string {
  return TOOL_PHASES[name] ?? (READ_ONLY_TOOLS.has(name) ? "reading" : "applying");
}

/** Localized, non-sensitive activity categories shown while a tool is running. */
function activityForTool(name: string, input: Record<string, unknown>): { key: string; detail?: string } {
  const groups: Record<string, string> = {
    get_song_overview: "activity_inspect",
    get_clip_notes: "activity_inspect",
    analyze_song: "activity_analyze",
    analyze_rendered_track: "activity_analyze",
    set_goal: "activity_plan",
    set_plan: "activity_plan",
    arrange_song: "activity_arrange",
    write_midi_clip: "activity_edit_clip",
    write_session_clip: "activity_edit_clip",
    set_clip_notes: "activity_edit_clip",
    delete_arrangement_clip: "activity_edit_clip",
    delete_session_clip: "activity_edit_clip",
    set_track_mixer: "activity_edit_track",
    set_track_state: "activity_edit_track",
    set_tempo: "activity_edit_track",
    insert_device: "activity_edit_device",
    replace_device: "activity_edit_device",
    set_device_parameter: "activity_edit_device",
    set_device_parameters: "activity_edit_device",
    generate_audio: "activity_generate",
    search_samples: "activity_search_samples",
    web_search: "activity_search_web",
    web_fetch: "activity_search_web",
  };
  const detail = [input.track_name, input.track, input.device_name, input.section, input.scene_name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return { key: groups[name] ?? (READ_ONLY_TOOLS.has(name) ? "activity_inspect" : "activity_edit"), ...(detail ? { detail } : {}) };
}

/** A mutation tool can report that its safety preflight made no Set change.
 * Keep such calls visible to the model, but exclude them from budgets,
 * verification, listen hints, and durable mutation receipts. */
function didExecute(result: unknown): boolean {
  return !(
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).executed === false
  );
}

export async function callTool(
  context: Ctx,
  actions: { tool: string; input: unknown; result: unknown }[],
  name: string,
  input: Record<string, unknown>,
  yolo: boolean,
): Promise<string> {
  // Prompt context is helpful but not a security boundary. Re-resolve the
  // transient Live selection immediately before every mutation so an agent
  // cannot accidentally write beyond the range/slots the user selected.
  if (!READ_ONLY_TOOLS.has(name)) {
    const refusal = selectionGuard(context, resolvedSelection(context), toolState.activeGlobalIntent, name, input);
    if (refusal) {
      const refused = { error: friendlyToolError(refusal, toolState.activeLanguage) };
      actions.push({ tool: name, input, result: refused });
      toolHooks.debugLog(context, `TOOL ${name} REFUSED: selection boundary`);
      return JSON.stringify(refused);
    }
  }
  // Delete permission is never inferred from YOLO, tool history, or a prior
  // chat message. The dispatcher repeats this guard as defense in depth.
  if (isDeleteTool(name) && !deleteToolIsAuthorized(name, toolState.activeDeleteAuthorization)) {
    const refused = deleteAuthorizationError(name, toolState.activeLanguage);
    actions.push({ tool: name, input, result: refused });
    toolHooks.debugLog(context, `TOOL ${name} REFUSED: no explicit delete authorization`);
    return JSON.stringify(refused);
  }
  // Agent-loop step budget (agent/loop.ts): once AGENT_MAX_STEPS mutations
  // actually executed this turn, further mutating calls are refused BEFORE
  // running — and before the user is asked to confirm. The refusal never
  // enters executedToolsThisTurn (it didn't execute), so the budget can't be
  // talked past; the model must wrap up and let the user say "continue".
  if (
    !READ_ONLY_TOOLS.has(name) &&
    countMutations(executedToolsThisTurn, READ_ONLY_TOOLS) >= AGENT_MAX_STEPS
  ) {
    const refused = stepBudgetError(toolState.activeLanguage);
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
    !READ_ONLY_TOOLS.has(name) &&
    !deleteToolIsAuthorized(name, toolState.activeDeleteAuthorization) &&
    !refinePreAuthorized &&
    (!yolo || COSTLY_TOOLS.has(name));
  if (needsConfirm) {
    const allowed = await askConfirmation(name, input);
    if (!allowed) {
      const denied = { error: commonText(toolState.activeLanguage, "userDenied") };
      actions.push({ tool: name, input, result: denied });
      toolHooks.debugLog(context, `TOOL ${name} DENIED by user`);
      return JSON.stringify(denied);
    }
  }
  let result: unknown;
  let executed = true;
  toolState.phase = phaseForTool(name);
  toolState.activity = activityForTool(name, input);
  try {
    result = await runTool(context, name, input);
    executed = didExecute(result);
    // Plan-layer step matching counts every call that actually ran — a call
    // whose verify later fails still executed ("missed target" ≠ "never
    // happened"); the step's effect check carries that diagnosis instead.
    if (!PLAN_META_TOOLS.has(name) && executed) executedToolsThisTurn.push(name);
  } catch (err) {
    toolHooks.debugLog(context, `TOOL ${name} ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    result = { error: friendlyToolError(err, toolState.activeLanguage) };
    executed = false;
  } finally {
    // The model digests the result next — back to the generic phase.
    toolState.phase = "thinking";
  }
  if (executed) result = await verifyToolResult(context, name, input, result);
  const errorText =
    result && typeof result === "object" && !Array.isArray(result) && "error" in result
      ? String((result as Record<string, unknown>).error ?? "工具失败")
      : undefined;
  const errorClass = errorText
    ? `${name}:${errorText.split("\n", 1)[0].slice(0, 240)}`
    : undefined;
  consecutiveToolErrors = nextToolErrorState(consecutiveToolErrors, errorClass);
  if (consecutiveToolErrors.count >= AGENT_MAX_CONSECUTIVE_TOOL_ERRORS && errorText) {
    result = {
      ...(result as Record<string, unknown>),
      error:
        `${errorText}\n同一工具连续 ${AGENT_MAX_CONSECUTIVE_TOOL_ERRORS} 次失败，已停止重复调用；请重新读取当前状态并改用不同方案。`,
      repeated_tool_error: true,
    };
    toolState.stopRequested = true;
    toolState.stopReason = "repeated_tool_error";
    toolHooks.debugLog(
      context,
      `TOOL ${name} AUTO-STOP: repeated error ${consecutiveToolErrors.count}/${AGENT_MAX_CONSECUTIVE_TOOL_ERRORS}`,
    );
  }
  // Deterministic listen hint (tools/listenhint.ts): after a successful
  // mutation, tell the user what to play to judge the change. Advisory only —
  // a hint bug must never fail or alter a working call.
  if (executed && result !== null && typeof result === "object" && !("error" in result)) {
    try {
      const hint = listenHintFor(context, name, input, result as Record<string, unknown>);
      if (hint) result = { ...(result as Record<string, unknown>), listen_hint: hint };
    } catch (err) {
      toolHooks.debugLog(context, `LISTEN-HINT skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Count executed mutations so a set_goal declared mid-turn can flag that
  // its baseline is already post-change (handleSetGoal's late warning).
  if (
    !READ_ONLY_TOOLS.has(name) &&
    executed &&
    !(result !== null && typeof result === "object" && "error" in result)
  ) {
    mutationsThisTurn++;
  }
  const rawResultJson = JSON.stringify(result);
  result = sanitizeToolResultLanguage(result, toolState.activeLanguage);
  actions.push({ tool: name, input, result });
  const resultJson = JSON.stringify(result);
  toolHooks.debugLog(context, `TOOL ${name} ${JSON.stringify(input)} -> ${rawResultJson.slice(0, 400)}`);
  const completedActivity = toolState.activity;
  if (completedActivity) {
    // The UI polls /api/status every 900ms. Keep this activity briefly after
    // a fast tool returns so the next poll can still render it.
    setTimeout(() => {
      if (toolState.activity === completedActivity) toolState.activity = null;
    }, 1800);
  }
  return truncateResult(resultJson);
}

/** Reset the per-turn goal/plan/mutation bookkeeping — called by chat() at
 * the start of every user turn so a stale goal never gates a new request. */
export function resetTurnState(): void {
  clearTurnGoalOutcome();
  pendingGoal = null;
  pendingPlan = null;
  mutationsThisTurn = 0;
  executedToolsThisTurn = [];
  consecutiveToolErrors = { count: 0 };
}

// Self-register the set_goal/set_plan tool handlers (dispatcher calls these
// through toolHooks at request time).
toolHooks.handleSetGoal = handleSetGoal;
toolHooks.handleSetPlan = handleSetPlan;
