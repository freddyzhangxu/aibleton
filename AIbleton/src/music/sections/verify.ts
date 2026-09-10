/**
 * music/sections/verify.ts — did the TARGET section actually change the way
 * the goal asked?
 *
 * Two pure entry points:
 *
 *   projectSectionVerificationCriteria(goal, actions, target, references)
 *     — deterministic Goal/Action → metric-direction criteria. Goal criteria
 *       produce REQUIRED criteria (weight 1); creative actions produce
 *       supporting ones (weight = action strength). Goal > Creative Actions,
 *       always: an action candidate never gates the verdict.
 *
 *   verifySectionChange(before, afterIntel, goal)
 *     — re-matches the SAME target in the after-intelligence (target identity
 *       stability: id → label → ±1 bar), then compares the before/after
 *       metric values and the target↔reference relationships.
 *
 * Honesty rules (PR11–14 inherited):
 * - undefined before OR after → the criterion is "unknown", never failed and
 *   never faked as 0.
 * - Tiny numerical noise is not a musical change: every metric has a
 *   centralized threshold (SECTION_DELTA_THRESHOLDS) the delta must clear.
 * - Confidence is weakest-link: min(before, after) per criterion, min across
 *   criteria overall — an averaged-away low-confidence metric would lie.
 * - The goal gate (goal/evaluate.ts) remains the final authority; this
 *   verdict is additional EVIDENCE for the retry loop, not a second gate.
 */

import type { MusicGoal } from "../../goal/types.js";
import type { SectionFeatures } from "../features/types.js";
import type { MusicalRelationships } from "../relationships/types.js";
import type { CreativeAction, CreativeActionKind } from "../actions/types.js";
import type { MusicIntelligence } from "../intelligence/types.js";
import { matchTargetSectionAfter, normalizeSectionLabel } from "./resolve.js";
import type {
  SectionCriterionResult,
  SectionPlanningContext,
  SectionReference,
  SectionRelationshipChange,
  SectionTarget,
  SectionVerification,
  SectionVerificationCriterion,
  SectionVerificationDirection,
  SectionVerificationMetric,
  SectionVerificationStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Thresholds — centralized, deterministic, documented. A delta below the
// threshold is numerical noise, not a musical change (§42).
// ---------------------------------------------------------------------------

export const SECTION_DELTA_THRESHOLDS: Record<SectionVerificationMetric, number> = {
  energy: 0.03,
  density: 0.03,
  active_track_ratio: 0.03,
  variation: 0.03,
  repetition: 0.03,
  rhythmic_activity: 0.03,
  impact: 0.03,
  contrast: 0.03,
  similarity: 0.03,
};

// ---------------------------------------------------------------------------
// Criteria projection
// ---------------------------------------------------------------------------

/** Action kind → the metric/direction it implies (§38). Directional
 * arrangement/structure kinds map to relative metrics when a reference
 * exists; kinds without verification semantics map to nothing. */
const ACTION_METRIC_MAP: Partial<Record<CreativeActionKind, { metric: SectionVerificationMetric; direction: SectionVerificationDirection }>> = {
  increase_energy: { metric: "energy", direction: "increase" },
  decrease_energy: { metric: "energy", direction: "decrease" },
  increase_density: { metric: "density", direction: "increase" },
  decrease_density: { metric: "density", direction: "decrease" },
  increase_layering: { metric: "active_track_ratio", direction: "increase" },
  restore_layer: { metric: "active_track_ratio", direction: "increase" },
  decrease_layering: { metric: "active_track_ratio", direction: "decrease" },
  remove_layer: { metric: "active_track_ratio", direction: "decrease" },
  introduce_variation: { metric: "variation", direction: "increase" },
  develop_section: { metric: "variation", direction: "increase" },
  introduce_rhythmic_variation: { metric: "variation", direction: "increase" },
  increase_repetition: { metric: "repetition", direction: "increase" },
  increase_rhythmic_activity: { metric: "rhythmic_activity", direction: "increase" },
  decrease_rhythmic_activity: { metric: "rhythmic_activity", direction: "decrease" },
  increase_impact: { metric: "impact", direction: "increase" },
  reduce_impact: { metric: "impact", direction: "decrease" },
  increase_section_contrast: { metric: "contrast", direction: "increase" },
  reduce_section_contrast: { metric: "contrast", direction: "decrease" },
};

/** "Drop 2" / "drop_2" / the goal's own target text → is it THIS target? */
function nameMatchesTarget(raw: string, target: SectionTarget): boolean {
  const name = raw.replace(/^baseline:/i, "").trim();
  if (!name) return false;
  if (normalizeSectionLabel(name) === normalizeSectionLabel(target.name)) return true;
  return target.requested !== undefined && normalizeSectionLabel(name) === normalizeSectionLabel(target.requested);
}

/** Resolve a criteria-named comparison section to one of the selected
 * references (by normalized name). Unresolvable partners yield no criterion
 * — verification stays silent rather than guessing. */
function referenceByName(raw: string, references: readonly SectionReference[]): SectionReference | undefined {
  const norm = normalizeSectionLabel(raw.replace(/^baseline:/i, "").trim());
  if (!norm) return undefined;
  return references.find((r) => normalizeSectionLabel(r.name) === norm);
}

/** The primary reference for a relative criterion: the action's own
 * relatedSectionId when it points at a selected reference, else the
 * highest-ranked reference (references arrive relevance-sorted). */
function primaryReference(
  a: CreativeAction | undefined,
  references: readonly SectionReference[],
): SectionReference | undefined {
  if (a?.target.relatedSectionId) {
    const hit = references.find((r) => r.sectionId === a.target.relatedSectionId);
    if (hit) return hit;
  }
  return references[0];
}

function upsert(list: SectionVerificationCriterion[], c: SectionVerificationCriterion): void {
  const dup = list.find(
    (x) => x.metric === c.metric && x.direction === c.direction && x.referenceSectionId === c.referenceSectionId,
  );
  if (!dup) {
    list.push(c);
    return;
  }
  // Same claim from two sources: keep the strongest; a goal criterion always
  // makes it required.
  dup.weight = Math.max(dup.weight, c.weight);
  dup.required = dup.required || c.required;
}

export function projectSectionVerificationCriteria(
  goal: MusicGoal,
  actions: readonly CreativeAction[],
  target: SectionTarget,
  references: readonly SectionReference[],
): SectionVerificationCriterion[] {
  const criteria: SectionVerificationCriterion[] = [];

  // --- Goal criteria → REQUIRED ---
  for (const c of goal.successCriteria) {
    if (c.kind === "section_energy_gt") {
      const aBase = /^baseline:/i.test(c.a.trim());
      const bBase = /^baseline:/i.test(c.b.trim());
      const aIsTarget = nameMatchesTarget(c.a, target);
      const bIsTarget = nameMatchesTarget(c.b, target);
      if (aIsTarget && !aBase) {
        upsert(criteria, { metric: "energy", direction: "increase", required: true, weight: 1 });
        // "a must beat NAMED b" (not its own baseline) is a RELATIVE claim —
        // the target↔b contrast must grow, not just the target's energy.
        if (!bBase && !bIsTarget) {
          const ref = referenceByName(c.b, references);
          if (ref) {
            upsert(criteria, {
              metric: "contrast",
              direction: "increase",
              required: true,
              weight: 1,
              referenceSectionId: ref.sectionId,
            });
          }
        }
      } else if (bIsTarget && !bBase) {
        // "baseline:X > X" (calmer) or "Other > X" (quieter than a sibling):
        // the target's energy must DROP — the goal's direction, not a guess.
        upsert(criteria, { metric: "energy", direction: "decrease", required: true, weight: 1 });
      }
    } else if (c.kind === "section_tracks_gte" && c.n === "baseline" && nameMatchesTarget(c.section, target)) {
      // "at least as many tracks as before" — must not drop.
      upsert(criteria, { metric: "active_track_ratio", direction: "maintain", required: true, weight: 1 });
    }
  }

  // --- Creative actions → supporting criteria (never gate the verdict) ---
  for (const a of actions) {
    // Only actions about the target inform the target's verification.
    if (
      a.target.sectionId !== undefined &&
      a.target.sectionId !== target.sectionId &&
      a.target.relatedSectionId !== target.sectionId
    ) {
      continue;
    }
    const mapped = ACTION_METRIC_MAP[a.kind];
    if (!mapped) continue;
    const c: SectionVerificationCriterion = {
      ...mapped,
      required: false,
      weight: a.strength,
    };
    if (mapped.metric === "contrast") {
      const ref = primaryReference(a, references);
      if (!ref) continue; // no comparison anchor → no relative criterion
      c.referenceSectionId = ref.sectionId;
    }
    upsert(criteria, c);
    // Variation/development against a reprise partner: the pair's SIMILARITY
    // should drop — supporting evidence only, and only when the goal pushed
    // variation/development (§41: lower similarity is not universally good).
    if ((a.kind === "introduce_variation" || a.kind === "develop_section") && references.length) {
      const ref = primaryReference(a, references);
      if (ref) {
        upsert(criteria, {
          metric: "similarity",
          direction: "decrease",
          required: false,
          weight: a.strength,
          referenceSectionId: ref.sectionId,
        });
      }
    }
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// Metric extraction — every number read off the lower layers, never recomputed
// ---------------------------------------------------------------------------

interface MetricReading {
  value?: number;
  confidence?: number;
}

function sectionMetric(s: SectionFeatures, metric: SectionVerificationMetric): MetricReading {
  switch (metric) {
    case "energy":
      return { value: s.energy?.value, confidence: s.energy?.confidence };
    case "density":
      return { value: s.density };
    case "active_track_ratio":
      return { value: s.activeTrackRatio };
    case "variation":
      return { value: s.variation };
    case "repetition":
      return { value: s.repetition };
    case "rhythmic_activity":
      return { value: s.rhythmicActivity?.value, confidence: s.rhythmicActivity?.confidence };
    case "impact":
      return { value: s.impact?.value, confidence: s.impact?.confidence };
    default:
      return {};
  }
}

/** |energy delta| of the target↔reference pair, orientation-independent —
 * the CONTRAST magnitude, not its sign. Consecutive pairs only (the
 * relationships layer covers those); anything else reads unknown. */
function contrastMagnitude(rel: MusicalRelationships, aId: string, bId: string): MetricReading {
  const c = rel.contrasts.find(
    (x) =>
      (x.fromSectionId === aId && x.toSectionId === bId) ||
      (x.fromSectionId === bId && x.toSectionId === aId),
  );
  if (!c?.energyDelta) return {};
  return { value: Math.abs(c.energyDelta.value), confidence: c.energyDelta.confidence };
}

function pairSimilarity(rel: MusicalRelationships, aId: string, bId: string): MetricReading {
  const s = rel.similarities.find(
    (x) =>
      (x.aSectionId === aId && x.bSectionId === bId) ||
      (x.aSectionId === bId && x.bSectionId === aId),
  );
  if (!s) return {};
  return { value: s.similarity.value, confidence: s.similarity.confidence };
}

/** Re-match a reference in the after-intelligence: same id, else normalized
 * label. Positional fallback is the TARGET's privilege (its identity anchors
 * the verdict); a lost reference just reads unknown. */
function matchReferenceAfter(ref: SectionReference, afterIntel: MusicIntelligence): SectionFeatures | undefined {
  const sections = afterIntel.features.sections;
  const byId = sections.find((s) => s.sectionId === ref.sectionId);
  if (byId) return byId;
  const norm = normalizeSectionLabel(ref.name);
  const byLabel = sections.filter((s) => normalizeSectionLabel(s.name) === norm);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function judge(
  metric: SectionVerificationMetric,
  direction: SectionVerificationDirection,
  before?: number,
  after?: number,
): { status: SectionVerificationStatus; delta?: number } {
  if (before === undefined || after === undefined) return { status: "unknown" };
  const delta = after - before;
  const thr = SECTION_DELTA_THRESHOLDS[metric];
  switch (direction) {
    case "increase":
      return { delta, status: delta >= thr ? "passed" : "failed" };
    case "decrease":
      return { delta, status: delta <= -thr ? "passed" : "failed" };
    case "maintain":
      return { delta, status: Math.abs(delta) <= thr ? "passed" : "failed" };
  }
}

export function verifySectionChange(
  before: SectionPlanningContext,
  beforeIntel: MusicIntelligence,
  afterIntel: MusicIntelligence,
  goal: MusicGoal,
): SectionVerification {
  const criteria = projectSectionVerificationCriteria(goal, before.actions, before.target, before.references);
  const rematch = matchTargetSectionAfter(before.target, afterIntel);

  const base: Pick<SectionVerification, "target" | "matchedAfter"> = {
    target: {
      beforeSectionId: before.target.sectionId,
      ...(rematch.matched ? { afterSectionId: rematch.target.sectionId } : {}),
    },
    matchedAfter: rematch.matched,
  };

  // Target gone (deleted, or arrangement rebuilt beyond recognition): every
  // criterion is unknown — never fabricated as failure or success.
  if (!rematch.matched) {
    return {
      ...base,
      status: "unknown",
      criteria: criteria.map((c) => ({
        metric: c.metric,
        direction: c.direction,
        required: c.required,
        weight: c.weight,
        status: "unknown",
        ...(c.referenceSectionId !== undefined ? { referenceSectionId: c.referenceSectionId } : {}),
      })),
      relationshipChanges: [],
    };
  }

  const afterSection = afterIntel.features.sections.find((s) => s.sectionId === rematch.target.sectionId);
  if (!afterSection) {
    // Resolution and features disagree — fail soft, same shape as unmatched.
    return { ...base, matchedAfter: false, status: "unknown", criteria: [], relationshipChanges: [] };
  }

  const read = (
    metric: SectionVerificationMetric,
    referenceSectionId: string | undefined,
    side: "before" | "after",
  ): MetricReading => {
    if (metric === "contrast" || metric === "similarity") {
      // Relative metrics need BOTH ends on the same side.
      const ref = referenceSectionId
        ? before.references.find((r) => r.sectionId === referenceSectionId)
        : undefined;
      if (!ref) return {};
      if (side === "before") {
        return metric === "contrast"
          ? contrastMagnitude(beforeIntel.relationships, before.target.sectionId, ref.sectionId)
          : pairSimilarity(beforeIntel.relationships, before.target.sectionId, ref.sectionId);
      }
      const afterRef = matchReferenceAfter(ref, afterIntel);
      if (!afterRef) return {};
      return metric === "contrast"
        ? contrastMagnitude(afterIntel.relationships, afterSection.sectionId, afterRef.sectionId)
        : pairSimilarity(afterIntel.relationships, afterSection.sectionId, afterRef.sectionId);
    }
    return side === "before"
      ? sectionMetric(before.targetFeatures, metric)
      : sectionMetric(afterSection, metric);
  };

  const results: SectionCriterionResult[] = criteria.map((c) => {
    const b = read(c.metric, c.referenceSectionId, "before");
    const a = read(c.metric, c.referenceSectionId, "after");
    const { status, delta } = judge(c.metric, c.direction, b.value, a.value);
    const conf =
      b.confidence !== undefined && a.confidence !== undefined
        ? Math.min(b.confidence, a.confidence)
        : (b.confidence ?? a.confidence);
    return {
      metric: c.metric,
      direction: c.direction,
      required: c.required,
      weight: c.weight,
      ...(b.value !== undefined ? { before: b.value } : {}),
      ...(a.value !== undefined ? { after: a.value } : {}),
      ...(delta !== undefined ? { delta } : {}),
      status,
      ...(conf !== undefined ? { confidence: conf } : {}),
      ...(c.referenceSectionId !== undefined ? { referenceSectionId: c.referenceSectionId } : {}),
    };
  });

  // Relationship changes for every selected reference — context for the
  // retry message even when no criterion judges them.
  const relationshipChanges: SectionRelationshipChange[] = [];
  for (const ref of before.references) {
    const afterRef = matchReferenceAfter(ref, afterIntel);
    for (const metric of ["contrast", "similarity"] as const) {
      const b =
        metric === "contrast"
          ? contrastMagnitude(beforeIntel.relationships, before.target.sectionId, ref.sectionId)
          : pairSimilarity(beforeIntel.relationships, before.target.sectionId, ref.sectionId);
      const a = afterRef
        ? metric === "contrast"
          ? contrastMagnitude(afterIntel.relationships, afterSection.sectionId, afterRef.sectionId)
          : pairSimilarity(afterIntel.relationships, afterSection.sectionId, afterRef.sectionId)
        : {};
      if (b.value === undefined && a.value === undefined) continue;
      relationshipChanges.push({
        referenceSectionId: ref.sectionId,
        metric,
        ...(b.value !== undefined ? { before: b.value } : {}),
        ...(a.value !== undefined ? { after: a.value } : {}),
        ...(b.value !== undefined && a.value !== undefined ? { delta: a.value - b.value } : {}),
      });
    }
  }

  // Overall: goal-derived REQUIRED criteria gate when the goal declared any
  // (§47). Otherwise the verdict stands on the STRONGEST supporting claims
  // (top-weight action-derived criteria) — Goal > Creative Actions means a
  // weaker hint's miss never sinks the verdict, and the top hint is the one
  // the planner most likely acted on. unknown is NOT passed either way.
  const requiredResults = results.filter((r) => r.required);
  let judged = requiredResults;
  if (!judged.length && results.length) {
    const maxWeight = Math.max(...criteria.map((c) => c.weight));
    const top = new Set(
      criteria
        .filter((c) => c.weight === maxWeight)
        .map((c) => `${c.metric}:${c.direction}:${c.referenceSectionId ?? ""}`),
    );
    judged = results.filter((r) => top.has(`${r.metric}:${r.direction}:${r.referenceSectionId ?? ""}`));
  }
  let status: SectionVerificationStatus;
  if (!judged.length) status = "unknown";
  else if (judged.some((r) => r.status === "failed")) status = "failed";
  else if (judged.every((r) => r.status === "passed")) status = "passed";
  else status = "unknown";

  const confidences = judged.filter((r) => r.status !== "unknown" && r.confidence !== undefined).map((r) => r.confidence as number);

  return {
    ...base,
    status,
    criteria: results,
    relationshipChanges,
    ...(confidences.length ? { confidence: Math.min(...confidences) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Presentation — the verdict as retry-message lines (the goal gate's
// self-correction surface). The headline names exactly the JUDGED criteria
// that did not pass (the verdict's own rule: required criteria when the goal
// declared any, else the strongest supporting claims) — the retry must know
// WHICH metric gated, in WHICH section, by HOW MUCH. Non-judged supporting
// misses ride a second, explicitly subordinate line: evidence, never the
// complaint. Empty when the judged criteria all passed.
// ---------------------------------------------------------------------------

export function presentSectionVerification(ver: SectionVerification, sectionName: string): string[] {
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  const fmt = (v?: number): string => (v === undefined ? "?" : String(r2(v)));
  const fmtCrit = (c: SectionCriterionResult): string =>
    `${c.metric} 期望 ${c.direction}: ${fmt(c.before)}→${fmt(c.after)}` +
    (c.delta !== undefined ? ` (Δ${c.delta >= 0 ? "+" : ""}${r2(c.delta)})` : "") +
    (c.status === "unknown" ? " — 数据不足" : "") +
    (c.referenceSectionId !== undefined ? ` [vs ${c.referenceSectionId}]` : "");
  const lines: string[] = [];
  if (!ver.matchedAfter) {
    lines.push(
      `段落校验 / Section「${sectionName}」: 修改后无法重新定位目标段落（可能已被删除或编曲结构大变），按整曲标准判断。`,
    );
    return lines;
  }
  // The verdict's judged set: required criteria when any exist, else the
  // top-weight supporting claims (mirrors the status rule above).
  const required = ver.criteria.filter((c) => c.required);
  const judged = required.length
    ? required
    : ver.criteria.filter((c) => c.weight === Math.max(...ver.criteria.map((x) => x.weight), 0));
  const judgedMissed = judged.filter((c) => c.status !== "passed");
  if (!judgedMissed.length) return lines;
  lines.push(
    `段落校验 / Section「${sectionName}」${ver.status === "failed" ? "未达标" : "无法确认"}：${judgedMissed.map(fmtCrit).join("；")}`,
  );
  const judgedKeys = new Set(
    judged.map((c) => `${c.metric}:${c.direction}:${c.referenceSectionId ?? ""}`),
  );
  const supportingMissed = ver.criteria.filter(
    (c) => c.status !== "passed" && !judgedKeys.has(`${c.metric}:${c.direction}:${c.referenceSectionId ?? ""}`),
  );
  if (supportingMissed.length) {
    lines.push(`支持性指标 / supporting: ${supportingMissed.map(fmtCrit).join("；")}`);
  }
  return lines;
}
