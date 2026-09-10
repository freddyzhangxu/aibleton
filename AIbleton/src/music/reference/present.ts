/**
 * music/reference/present.ts — ReferencePlanningContext → bounded JSON block,
 * and ReferenceVerification → retry-message lines.
 *
 * Same rules as the PR13.5/PR15 presenters: deterministic, stable ordering,
 * 2 decimals, undefined omitted, no fabricated zeros, bounded length. The
 * reference block has its OWN budget (default 1800 chars) so it can never
 * inflate the section block's budget (§33).
 *
 * Cut order (§35): low-confidence gaps → low-strength gaps → secondary
 * metrics → lower-ranked actions → the target/reference identity is never cut.
 */

import type { CreativeAction } from "../actions/types.js";
import type {
  ReferenceGap,
  ReferenceGapMetric,
  ReferencePlanningContext,
  ReferenceVerification,
} from "./types.js";

export const REFERENCE_CONTEXT_BUDGET = 1800;

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Metrics the planner most often acts on — the last to be cut. */
const PRIMARY_METRICS: ReferenceGapMetric[] = [
  "energy",
  "density",
  "rhythmic_activity",
  "impact",
  "variation",
  "section_contrast",
];

/** Presentation order: meaningful gaps first (strength desc, ties by metric
 * declaration order), then "similar" comparisons (metric order). */
function orderGaps(gaps: readonly ReferenceGap[]): ReferenceGap[] {
  const rank = (g: ReferenceGap) => (g.direction === "similar" || g.direction === "unknown" ? 1 : 0);
  return [...gaps].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? b.strength - a.strength : 0) ||
      PRIMARY_METRICS.indexOf(a.metric) - PRIMARY_METRICS.indexOf(b.metric) ||
      (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0),
  );
}

function gapOut(g: ReferenceGap): Record<string, unknown> {
  const o: Record<string, unknown> = { metric: g.metric, dir: g.direction };
  if (g.current !== undefined) o.cur = r2(g.current.value);
  if (g.reference !== undefined) o.ref = r2(g.reference.value);
  if (g.delta !== undefined) o.delta = r2(g.delta);
  if (g.confidence !== undefined) o.conf = r2(g.confidence);
  return o;
}

function actionOut(a: CreativeAction): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: a.kind, str: r2(a.strength) };
  if (a.confidence !== undefined) o.conf = r2(a.confidence);
  return o;
}

interface CutStage {
  minConfidence: number; // drop gaps below this (when they carry one)
  minStrength: number; // drop meaningful gaps below this
  primaryOnly: boolean;
  maxActions: number;
  maxGaps: number;
}

const STAGES: CutStage[] = [
  { minConfidence: 0, minStrength: 0, primaryOnly: false, maxActions: Number.MAX_SAFE_INTEGER, maxGaps: Number.MAX_SAFE_INTEGER },
  { minConfidence: 0.5, minStrength: 0, primaryOnly: false, maxActions: Number.MAX_SAFE_INTEGER, maxGaps: Number.MAX_SAFE_INTEGER },
  { minConfidence: 0.5, minStrength: 0.25, primaryOnly: false, maxActions: 5, maxGaps: 8 },
  { minConfidence: 0.5, minStrength: 0.25, primaryOnly: true, maxActions: 3, maxGaps: 6 },
  { minConfidence: 0, minStrength: 0, primaryOnly: true, maxActions: 3, maxGaps: 4 },
];

function render(ctx: ReferencePlanningContext, st: CutStage): Record<string, unknown> {
  let gaps = orderGaps(ctx.gaps).filter(
    (g) =>
      (g.confidence === undefined || g.confidence >= st.minConfidence) &&
      (g.direction === "similar" || g.strength >= st.minStrength),
  );
  if (st.primaryOnly) gaps = gaps.filter((g) => PRIMARY_METRICS.includes(g.metric));
  gaps = gaps.slice(0, st.maxGaps);

  const out: Record<string, unknown> = {
    reference: {
      match: ctx.referenceSectionId ?? null,
      coverage: r2(ctx.coverage),
    },
  };
  if (gaps.length) out.gaps = gaps.map(gapOut);
  const actions = ctx.actions.slice(0, st.maxActions);
  if (actions.length) out.actions = actions.map(actionOut);
  return out;
}

/**
 * Render the reference block under the char budget. As with the section
 * presenter, the last stage is returned even over budget — a complete
 * structure beats a truncated one.
 */
export function presentReferencePlanningContext(
  ctx: ReferencePlanningContext,
  options?: { maxChars?: number },
): Record<string, unknown> {
  const budget = options?.maxChars ?? REFERENCE_CONTEXT_BUDGET;
  let last: Record<string, unknown> = {};
  for (const st of STAGES) {
    last = render(ctx, st);
    if (JSON.stringify(last).length <= budget) return last;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Verification lines — the retry message's reference evidence
// ---------------------------------------------------------------------------

/**
 * Reference progress as retry-message lines (bilingual, matching
 * presentSectionVerification). Only UNSATISFIED measured metrics are listed —
 * "what still hasn't moved toward the reference" is the retry's correction
 * target; satisfied metrics are silent (the goal gate is the authority).
 */
export function presentReferenceVerification(vers: readonly ReferenceVerification[]): string[] {
  const fmt = (v?: number): string => (v === undefined ? "?" : String(r2(v)));
  const missed = vers.filter((v) => v.beforeGap !== undefined && v.satisfied !== true);
  if (!missed.length) return [];
  const parts = missed.map(
    (v) =>
      `${v.metric}: 差距 ${fmt(v.beforeGap)}→${fmt(v.afterGap)}` +
      (v.gapReduction !== undefined ? ` (缩小 ${r2(v.gapReduction)})` : " (修改后无法比较)"),
  );
  return [
    `参考校验 / Reference: 与参考的差距未有效缩小 — ${parts.join("；")}` +
      `。继续在原目标段落内缩小这些差距，不要转向其他段落，也不要试图复制参考本身。`,
  ];
}
