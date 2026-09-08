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
 */
export type Criterion =
  | { kind: "section_energy_gt"; a: string; b: string }
  | { kind: "section_tracks_gte"; section: string; n: number | "baseline" }
  | { kind: "role_present"; role: string; section?: string }
  | { kind: "tempo_unchanged" }
  | { kind: "key_unchanged" }
  | { kind: "track_count_gte"; n: number | "baseline" }
  | { kind: "no_new_tracks" }
  | { kind: "tracks_untouched"; names: string[] };

export const CRITERION_KINDS = [
  "section_energy_gt",
  "section_tracks_gte",
  "role_present",
  "tempo_unchanged",
  "key_unchanged",
  "track_count_gte",
  "no_new_tracks",
  "tracks_untouched",
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
    case "no_new_tracks":
      return { kind };
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
    default:
      warnings.push(`未知 kind「${kind || "(空)"}」已忽略 — 可用: ${CRITERION_KINDS.join(", ")}`);
      return null;
  }
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
