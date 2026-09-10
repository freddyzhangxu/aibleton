/**
 * plan/types.ts — the Plan layer: a declared route from goal to done.
 *
 * Between Goal (PR5: WHAT "done" means) and Verify (PR4: DID this call land)
 * sits the Plan: the relay model's own ordered route, declared via set_plan
 * AFTER set_goal and BEFORE touching the Set. Each step names its tool and
 * the effect it should produce — so the agent knows WHY it calls a tool and
 * WHAT should change afterwards, not just WHICH call comes next.
 *
 * Same design constraint as goal/ and verify/: expectedEffects are a CLOSED
 * vocabulary. The model picks a metric and fills its parameters; the judgement
 * lives entirely in deterministic code (check.ts) against the same GoalView
 * measurement surface goal criteria use. A plan never GATES — goal criteria
 * alone decide "done". The plan diagnoses: when the goal gate fails, the plan
 * report says which steps never executed and which predicted effects were not
 * observed, so the retry fixes the right step instead of flailing.
 *
 * Malformed entries are DROPPED with warnings (weak models emit partial junk);
 * a plan with zero valid steps is rejected outright.
 */

import type { MusicGoal } from "../goal/types.js";
import { AUDIO_BAND_NAMES } from "../dsp.js";

// ---------------------------------------------------------------------------
// ExpectedEffect — one predicted, machine-checkable consequence of a step.
// Flat parameter bag (same philosophy as goal's CRITERION_INPUT_SCHEMA): one
// shape for every metric, per-metric required params enforced in normalize.
// ---------------------------------------------------------------------------

export type EffectMetric =
  | "section_energy" // section note density (notes/bar) moves vs baseline
  | "section_tracks" // section active-track count moves vs baseline
  | "role_audible" // a role becomes audible (section-scoped or song-wide)
  | "track_notes" // a track's audible note count moves vs baseline
  | "track_count" // total track count moves vs baseline
  | "tempo" // song tempo moves vs baseline
  | "track_crest" // track's clip SOURCE FILE crest factor (dB) moves vs baseline
  | "track_band_energy"; // track's clip SOURCE FILE band energy fraction moves vs baseline

export const EFFECT_METRICS: EffectMetric[] = [
  "section_energy",
  "section_tracks",
  "role_audible",
  "track_notes",
  "track_count",
  "tempo",
  "track_crest",
  "track_band_energy",
];

export type EffectDirection = "increase" | "decrease";

export interface ExpectedEffect {
  metric: EffectMetric;
  /** Required for every metric except role_audible (presence IS the effect). */
  direction?: EffectDirection;
  section?: string; // section_energy / section_tracks (required), role_audible (optional)
  track?: string; // track_notes / track_crest / track_band_energy: track NAME, not index
  role?: string; // role_audible: any TrackRole, or the group low_end
  band?: string; // track_band_energy: sub | bass | lowMid | mid | highMid | high
}

export interface PlanStep {
  id: string; // model-provided or auto-assigned "step-N"
  description: string; // human-readable intent — displayed, never evaluated
  tool?: string; // the tool expected to carry this step out
  args?: unknown; // opaque echo of the intended call — display-only, never judged
  /** PR15: the musical region this step primarily edits — metadata for the
   * planner/diagnosis, NOT a sandbox: no tool call is intercepted by it.
   * Optional; old plans without scope behave exactly as before. */
  scope?: {
    /** Section name or id (same coordinates ExpectedEffect.section uses). */
    section?: string;
    startBeat?: number;
    endBeat?: number;
  };
  expectedEffects: ExpectedEffect[];
}

export interface MusicPlan {
  goal: MusicGoal; // reference to the pending goal, not a copy
  steps: PlanStep[];
}

/** True when any step predicts a source-file audio effect — the goal gate
 * must decode clip source files before building its after-view even when the
 * goal's own criteria contain no audio kinds. */
export function planNeedsAudio(plan: MusicPlan): boolean {
  return plan.steps.some((s) =>
    s.expectedEffects.some((fx) => fx.metric === "track_crest" || fx.metric === "track_band_energy"),
  );
}

// ---------------------------------------------------------------------------
// Input normalization — the model's raw set_plan input becomes PlanStep[] here.
// ---------------------------------------------------------------------------

export interface NormalizedPlan {
  steps: PlanStep[] | null;
  warnings: string[];
}

/** Anti-junk guards: plans are guidance, not data pipelines. */
const MAX_STEPS = 12;
const MAX_EFFECTS_PER_STEP = 4;
const MAX_DESCRIPTION = 200;
const MAX_ARGS_CHARS = 2000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function normDirection(v: unknown): EffectDirection | null {
  const s = str(v).toLowerCase();
  return s === "increase" || s === "decrease" ? s : null;
}

function normEffect(raw: unknown, warnings: string[]): ExpectedEffect | null {
  if (!raw || typeof raw !== "object") {
    warnings.push(`忽略非法效果（非对象）: ${JSON.stringify(raw)?.slice(0, 80)}`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const metric = str(r.metric) as EffectMetric;
  if (!EFFECT_METRICS.includes(metric)) {
    warnings.push(`未知 metric「${metric || "(空)"}」已忽略 — 可用: ${EFFECT_METRICS.join(", ")}`);
    return null;
  }
  const section = str(r.section);
  const track = str(r.track);
  const role = str(r.role).toLowerCase().replace(/[-\s]/g, "_");
  switch (metric) {
    case "section_energy":
    case "section_tracks": {
      const direction = normDirection(r.direction);
      if (!section || !direction) {
        warnings.push(`${metric} 需要 section 和 direction（increase|decrease），已忽略`);
        return null;
      }
      return { metric, direction, section };
    }
    case "track_notes": {
      const direction = normDirection(r.direction);
      if (!track || !direction) {
        warnings.push(`track_notes 需要 track（轨道名）和 direction（increase|decrease），已忽略`);
        return null;
      }
      return { metric, direction, track };
    }
    case "track_count":
    case "tempo": {
      const direction = normDirection(r.direction);
      if (!direction) {
        warnings.push(`${metric} 需要 direction（increase|decrease），已忽略`);
        return null;
      }
      return { metric, direction };
    }
    case "role_audible": {
      if (!role) {
        warnings.push(`role_audible 需要 role（或组 low_end），已忽略`);
        return null;
      }
      return section ? { metric, role, section } : { metric, role };
    }
    case "track_crest": {
      const direction = normDirection(r.direction);
      if (!track || !direction) {
        warnings.push(`track_crest 需要 track（轨道名）和 direction（increase|decrease），已忽略`);
        return null;
      }
      return { metric, direction, track };
    }
    case "track_band_energy": {
      const direction = normDirection(r.direction);
      const band = str(r.band);
      if (!track || !direction) {
        warnings.push(`track_band_energy 需要 track（轨道名）和 direction（increase|decrease），已忽略`);
        return null;
      }
      if (!(AUDIO_BAND_NAMES as readonly string[]).includes(band)) {
        warnings.push(`track_band_energy 的 band「${band || "(空)"}」不可用 — 可用: ${AUDIO_BAND_NAMES.join(", ")}，已忽略`);
        return null;
      }
      return { metric, direction, track, band };
    }
  }
}

const MAX_SCOPE_SECTION = 64;

/** PR15 step scope: section label + beat range. Malformed pieces are DROPPED
 * (NaN/Infinity/negative beats, end <= start, oversized names) — never a
 * crash, and a bad range never takes the section name down with it. */
function normScope(raw: unknown, warnings: string[]): PlanStep["scope"] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") {
    warnings.push(`scope 必须是对象，已忽略`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: NonNullable<PlanStep["scope"]> = {};
  const section = str(r.section ?? r.sectionId); // accept both spellings
  if (section) {
    if (section.length > MAX_SCOPE_SECTION) {
      warnings.push(`scope.section 超过 ${MAX_SCOPE_SECTION} 字符已忽略`);
    } else {
      out.section = section;
    }
  }
  const beat = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const start = beat(r.startBeat);
  const end = beat(r.endBeat);
  if (r.startBeat !== undefined || r.endBeat !== undefined) {
    if (start !== null && end !== null && end > start) {
      out.startBeat = start;
      out.endBeat = end;
    } else {
      warnings.push(`scope 的 beat 范围非法（需要 0 ≤ startBeat < endBeat 的有限数值），已忽略`);
    }
  }
  return out.section || out.startBeat !== undefined ? out : undefined;
}

function normArgs(raw: unknown, warnings: string[]): unknown {
  if (raw === undefined) return undefined;
  try {
    const s = JSON.stringify(raw);
    if (s && s.length > MAX_ARGS_CHARS) {
      warnings.push(`args 超过 ${MAX_ARGS_CHARS} 字符已丢弃（计划只需意图，不需要完整参数）`);
      return undefined;
    }
    return raw;
  } catch {
    warnings.push(`args 无法序列化，已丢弃`);
    return undefined;
  }
}

/**
 * The model's raw steps become a normalized step list. `validTools` is the
 * server's tool-name set — an unknown tool name nulls the step's tool (the
 * step survives for its description) so a typo can't sink the whole plan.
 */
export function normalizePlan(input: Record<string, unknown>, validTools: ReadonlySet<string>): NormalizedPlan {
  const warnings: string[] = [];
  const raw = input.steps;
  if (!Array.isArray(raw)) {
    return { steps: null, warnings: ["steps 必须是数组"] };
  }
  if (raw.length > MAX_STEPS) {
    warnings.push(`计划最多 ${MAX_STEPS} 步，超出的 ${raw.length - MAX_STEPS} 步已忽略`);
  }
  const steps: PlanStep[] = [];
  for (const [i, entry] of raw.slice(0, MAX_STEPS).entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`忽略非法步骤（非对象）: ${JSON.stringify(entry)?.slice(0, 80)}`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const description = str(e.description).slice(0, MAX_DESCRIPTION);
    if (!description) {
      warnings.push(`第 ${i + 1} 步缺少 description，已忽略`);
      continue;
    }
    const id = str(e.id) || `step-${steps.length + 1}`;
    let tool = str(e.tool);
    if (tool && !validTools.has(tool)) {
      warnings.push(`步骤「${description}」的 tool「${tool}」不存在，已置空（可用工具见工具列表）`);
      tool = "";
    }
    const effectsRaw = e.expectedEffects ?? e.expectedEffect; // accept both spellings
    let expectedEffects: ExpectedEffect[] = [];
    if (effectsRaw !== undefined) {
      if (!Array.isArray(effectsRaw)) {
        warnings.push(`步骤「${description}」的 expectedEffects 必须是数组，已忽略`);
      } else {
        if (effectsRaw.length > MAX_EFFECTS_PER_STEP) {
          warnings.push(`步骤「${description}」最多 ${MAX_EFFECTS_PER_STEP} 个预期效果，超出的已忽略`);
        }
        expectedEffects = effectsRaw
          .slice(0, MAX_EFFECTS_PER_STEP)
          .map((fx) => normEffect(fx, warnings))
          .filter((fx): fx is ExpectedEffect => fx !== null);
      }
    }
    const args = normArgs(e.args, warnings);
    const scope = normScope(e.scope, warnings);
    steps.push({
      id,
      description,
      ...(tool ? { tool } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(scope ? { scope } : {}),
      expectedEffects,
    });
  }
  if (!steps.length) return { steps: null, warnings };
  return { steps, warnings };
}
