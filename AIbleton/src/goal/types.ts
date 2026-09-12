/**
 * goal/types.ts — the Goal/Intent layer: a user task as a checkable object.
 *
 * The relay model declares a MusicGoal (via the set_goal tool) BEFORE touching
 * the Set. The crucial design constraint, inherited from verify/: success
 * criteria are a CLOSED vocabulary — the model picks a `kind` and fills its
 * parameters, but the pass/fail judgement lives entirely in deterministic code
 * (evaluate.ts). Free-text objectives are display-only; they never participate
 * in evaluation, so the model cannot talk its way past a failed check.
 *
 * Targets reuse the Set's existing coordinate systems instead of inventing
 * stable IDs (there are none in Live): tracks by NAME (indices drift — the
 * server already re-resolves name+index on every tool call), sections by cue
 * name or the "bars N-M" labels analyze_song emits, clips by (t, i).
 */

import { AUDIO_BAND_NAMES, type AudioBandName } from "../dsp.js";
import { GEN_SCALAR_METRICS, type GenScalarMetric } from "../genlog/diff.js";

/** Scalar metric a gen_* criterion judges, or "band" for one band's energy
 * share (then `band` names which). Values come from the generation registry
 * (genlog/) — the generated FILE's decoded features, not the Set. */
export type GenCriterionMetric = GenScalarMetric | "band";

export type GoalType =
  | "create"
  | "edit"
  | "arrange"
  | "mix"
  | "sound_design"
  | "fix"
  | "analyze";

export const GOAL_TYPES: GoalType[] = [
  "create",
  "edit",
  "arrange",
  "mix",
  "sound_design",
  "fix",
  "analyze",
];

export interface GoalTarget {
  track?: string; // track NAME, not index
  section?: string; // cue name or "bars 9-16", matched case-insensitively
}

/**
 * One machine-checkable condition. `n` accepts a number or "baseline" — the
 * value captured when the goal was declared. In section_energy_gt, `b` is a
 * section name, or "baseline:<name>" to compare a section against its own
 * pre-change density. role_present accepts any TrackRole plus the group
 * "low_end" (kick|bass).
 *
 * The audio kinds (track_crest_gte, track_band_gte) judge the track's clip
 * SOURCE FILES — mixer/warp/device edits never move them; only replacing the
 * sample does. Declaring them triggers source-file analysis at baseline and
 * gate time (goalNeedsAudio); declaring them for a task the model should
 * solve with processing is a route to a doomed retry loop.
 *
 * The key kinds judge the AFTER view only: key_unchanged compares Live's
 * declared scale (root + intervals) when Scale Mode is on in both views —
 * user-set ground truth that doesn't wobble like the detected key — and
 * falls back to the detected keyBest otherwise. in_key / off_key_lte read
 * the duration-weighted off-scale ratio (analysis.offKey); when no scale is
 * usable or material is too thin the check FAILS as "unknowable" — the model
 * is told why and can turn Scale Mode on or explain the blocker.
 *
 * The gen kinds (gen_metric_gte, gen_improved_vs_prev) judge the generation
 * registry (genlog/) instead of the Set: the LATEST record at gate time vs
 * the latest record captured at goal declaration. gen_metric_gte needs only
 * the after-side; gen_improved_vs_prev additionally needs a pre-goal record
 * and a NEW generation during the turn — with neither it fails as unknowable,
 * never as "improved by 0". Both fail when the record carries no features
 * (e.g. an undecodable mp3) — unknown is unknown, never zero.
 */
export type Criterion =
  | { kind: "section_energy_gt"; a: string; b: string }
  | { kind: "section_tracks_gte"; section: string; n: number | "baseline" }
  | { kind: "role_present"; role: string; section?: string }
  | { kind: "tempo_unchanged" }
  | { kind: "key_unchanged" }
  | { kind: "in_key" }
  | { kind: "off_key_lte"; pct: number }
  | { kind: "track_count_gte"; n: number | "baseline" }
  | { kind: "no_new_tracks" }
  | { kind: "tracks_untouched"; names: string[] }
  | { kind: "track_crest_gte"; track: string; db: number }
  | { kind: "track_band_gte"; track: string; band: AudioBandName; pct: number }
  | { kind: "gen_metric_gte"; metric: GenCriterionMetric; band?: AudioBandName; value: number }
  | {
      kind: "gen_improved_vs_prev";
      metric: GenCriterionMetric;
      band?: AudioBandName;
      direction: "up" | "down";
      min_delta: number;
    };

export const CRITERION_KINDS = [
  "section_energy_gt",
  "section_tracks_gte",
  "role_present",
  "tempo_unchanged",
  "key_unchanged",
  "in_key",
  "off_key_lte",
  "track_count_gte",
  "no_new_tracks",
  "tracks_untouched",
  "track_crest_gte",
  "track_band_gte",
  "gen_metric_gte",
  "gen_improved_vs_prev",
] as const;

export interface MusicGoal {
  type: GoalType;
  target?: GoalTarget;
  objective: string; // human-readable only — evaluated? never
  constraints: Criterion[]; // hard boundaries that must still hold at the end
  successCriteria: Criterion[]; // end-state conditions defining "done"
}

/** One judged condition — same shape as verify's VerificationCheck. */
export interface GoalCheck {
  id: string;
  passed: boolean;
  expected: string;
  actual?: string;
}

export interface GoalEvaluation {
  met: boolean;
  checks: (GoalCheck & { constraint: boolean })[];
  constraintIssues: string[]; // violated hard boundaries
  criteriaIssues: string[]; // unmet success conditions
}

// ---------------------------------------------------------------------------
// Input normalization — the model's raw tool input becomes a MusicGoal here.
// Malformed entries are DROPPED with warnings (weak models emit partial junk);
// a goal with zero valid conditions is rejected outright.
// ---------------------------------------------------------------------------

export interface NormalizedGoal {
  goal: MusicGoal | null;
  warnings: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function normN(v: unknown): number | "baseline" | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().toLowerCase() === "baseline") return "baseline";
  return null;
}

function normCriterion(raw: unknown, warnings: string[]): Criterion | null {
  if (!raw || typeof raw !== "object") {
    warnings.push(`忽略非法条目（非对象）: ${JSON.stringify(raw)?.slice(0, 80)}`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const kind = str(r.kind);
  switch (kind) {
    case "section_energy_gt": {
      const a = str(r.a);
      const b = str(r.b);
      if (!a || !b) {
        warnings.push(`section_energy_gt 需要 a 和 b（段落名），已忽略`);
        return null;
      }
      return { kind, a, b };
    }
    case "section_tracks_gte": {
      const section = str(r.section);
      const n = normN(r.n);
      if (!section || n === null) {
        warnings.push(`section_tracks_gte 需要 section 和 n（数字或 "baseline"），已忽略`);
        return null;
      }
      return { kind, section, n };
    }
    case "role_present": {
      const role = str(r.role).toLowerCase().replace(/[-\s]/g, "_");
      if (!role) {
        warnings.push(`role_present 需要 role，已忽略`);
        return null;
      }
      const section = str(r.section);
      return section ? { kind, role, section } : { kind, role };
    }
    case "tempo_unchanged":
    case "key_unchanged":
    case "in_key":
    case "no_new_tracks":
      return { kind };
    case "off_key_lte": {
      const pct = typeof r.pct === "number" && Number.isFinite(r.pct) ? r.pct : null;
      if (pct === null || pct < 0 || pct >= 1) {
        warnings.push(`off_key_lte 需要 pct（0-1 之间的小数，调外音占比上限），已忽略`);
        return null;
      }
      return { kind, pct };
    }
    case "track_count_gte": {
      const n = normN(r.n);
      if (n === null) {
        warnings.push(`track_count_gte 需要 n（数字或 "baseline"），已忽略`);
        return null;
      }
      return { kind, n };
    }
    case "tracks_untouched": {
      const names = Array.isArray(r.names) ? r.names.map(str).filter(Boolean) : [];
      if (!names.length) {
        warnings.push(`tracks_untouched 需要 names（轨道名数组），已忽略`);
        return null;
      }
      return { kind, names };
    }
    case "track_crest_gte": {
      const track = str(r.track);
      const db = typeof r.db === "number" && Number.isFinite(r.db) ? r.db : null;
      if (!track || db === null) {
        warnings.push(`track_crest_gte 需要 track（轨道名）和 db（数字），已忽略`);
        return null;
      }
      return { kind, track, db };
    }
    case "track_band_gte": {
      const track = str(r.track);
      const band = str(r.band);
      const pct = typeof r.pct === "number" && Number.isFinite(r.pct) ? r.pct : null;
      if (!track || pct === null || pct <= 0 || pct >= 1) {
        warnings.push(`track_band_gte 需要 track（轨道名）和 pct（0-1 之间的小数），已忽略`);
        return null;
      }
      if (!(AUDIO_BAND_NAMES as readonly string[]).includes(band)) {
        warnings.push(`track_band_gte 的 band「${band || "(空)"}」不可用 — 可用: ${AUDIO_BAND_NAMES.join(", ")}，已忽略`);
        return null;
      }
      return { kind, track, band: band as AudioBandName, pct };
    }
    case "gen_metric_gte":
    case "gen_improved_vs_prev": {
      const metric = str(r.metric);
      const band = str(r.band);
      if (metric !== "band" && !(GEN_SCALAR_METRICS as readonly string[]).includes(metric)) {
        warnings.push(
          `${kind} 的 metric「${metric || "(空)"}」不可用 — 可用: ${GEN_SCALAR_METRICS.join(", ")}, band，已忽略`,
        );
        return null;
      }
      if (metric === "band" && !(AUDIO_BAND_NAMES as readonly string[]).includes(band)) {
        warnings.push(
          `${kind} 的 metric 为 band 时需要 band（${AUDIO_BAND_NAMES.join(", ")}），已忽略`,
        );
        return null;
      }
      const base = {
        kind,
        metric: metric as GenCriterionMetric,
        ...(metric === "band" ? { band: band as AudioBandName } : {}),
      };
      if (kind === "gen_metric_gte") {
        const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
        if (value === null) {
          warnings.push(`gen_metric_gte 需要 value（数字阈值），已忽略`);
          return null;
        }
        return { ...base, kind, value };
      }
      const direction = str(r.direction);
      if (direction !== "up" && direction !== "down") {
        warnings.push(`gen_improved_vs_prev 需要 direction（"up" 或 "down"），已忽略`);
        return null;
      }
      const minDelta =
        typeof r.min_delta === "number" && Number.isFinite(r.min_delta) && r.min_delta > 0
          ? r.min_delta
          : null;
      if (minDelta === null) {
        warnings.push(`gen_improved_vs_prev 需要 min_delta（正数，最小改善幅度），已忽略`);
        return null;
      }
      return { ...base, kind, direction, min_delta: minDelta };
    }
    default:
      warnings.push(`未知 kind「${kind || "(空)"}」已忽略 — 可用: ${CRITERION_KINDS.join(", ")}`);
      return null;
  }
}

/** True when any condition judges clip source-file audio — the server runs
 * source-file analysis before capturing the baseline/after views only then. */
export function goalNeedsAudio(goal: MusicGoal): boolean {
  return [...goal.constraints, ...goal.successCriteria].some(
    (c) => c.kind === "track_crest_gte" || c.kind === "track_band_gte",
  );
}

/** True when any condition judges the generation registry — the server
 * attaches the latest genlog record to the baseline/after GoalViews only
 * then (goalNeedsAudio is about the Set's clips; this is about generated
 * files, no audio enrichment needed). */
export function goalNeedsGenlog(goal: MusicGoal): boolean {
  return [...goal.constraints, ...goal.successCriteria].some(
    (c) => c.kind === "gen_metric_gte" || c.kind === "gen_improved_vs_prev",
  );
}

export function normalizeGoal(input: Record<string, unknown>): NormalizedGoal {
  const warnings: string[] = [];
  const typeRaw = str(input.type) as GoalType;
  const type = GOAL_TYPES.includes(typeRaw) ? typeRaw : "edit";
  if (typeRaw && type !== typeRaw) warnings.push(`未知 type「${typeRaw}」→ 按 edit 处理`);

  const objective = str(input.objective);
  if (!objective) warnings.push("objective 为空（仅展示用，不影响判定）");

  const targetRaw = input.target;
  const target: GoalTarget = {};
  if (targetRaw && typeof targetRaw === "object") {
    const t = targetRaw as Record<string, unknown>;
    if (str(t.track)) target.track = str(t.track);
    if (str(t.section)) target.section = str(t.section);
  }

  const read = (key: "constraints" | "successCriteria"): Criterion[] => {
    const raw = input[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      warnings.push(`${key} 必须是数组，已忽略`);
      return [];
    }
    return raw
      .map((c) => normCriterion(c, warnings))
      .filter((c): c is Criterion => c !== null);
  };

  const constraints = read("constraints");
  const successCriteria = read("successCriteria");
  if (!constraints.length && !successCriteria.length) {
    return { goal: null, warnings };
  }
  return {
    goal: {
      type,
      ...(target.track || target.section ? { target } : {}),
      objective,
      constraints,
      successCriteria,
    },
    warnings,
  };
}
