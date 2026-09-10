/**
 * music/reference/index.ts — composition root of Reference Track Intelligence.
 *
 * The chain (all pure, all deterministic):
 *
 *   analyzeReferenceBuffer  (analyze.ts — the only audio-input boundary)
 *   → detectReferenceSections / alignReferenceSections
 *   → deriveReferenceGaps → deriveReferenceActions
 *   → buildReferenceIntelligence → buildReferencePlanningContext
 *   → presentReferencePlanningContext → Planner
 *   → verifyReferenceProgress → presentReferenceVerification → Goal Gate
 *
 * Reference is an ENHANCEMENT, never a dependency: every entry point treats
 * "no reference / no sections / no alignment" as a first-class answer, so the
 * plain MusicIntelligence flow keeps working unchanged (§62, §64).
 */

import type { SectionFeatures } from "../features/types.js";
import type { SectionTarget } from "../sections/types.js";
import { alignReferenceSections } from "./align.js";
import { deriveReferenceGaps, REFERENCE_GAP_METRICS } from "./gap.js";
import { deriveReferenceActions } from "./actions.js";
import type {
  ReferenceAnalysis,
  ReferenceGap,
  ReferenceIntelligence,
  ReferencePlanningContext,
  ReferenceSection,
} from "./types.js";

export * from "./types.js";
export {
  analyzeReferenceBuffer,
  computeReferenceCurves,
  estimateTempo,
  REFERENCE_ANALYZER_VERSION,
  REFERENCE_MAX_SECONDS,
  type ReferenceAnalysisOutcome,
  type ReferenceCurves,
  type TempoEstimate,
} from "./analyze.js";
export {
  detectReferenceBoundaries,
  detectReferenceSections,
  featuresFromSegmentAudio,
  MIN_SECTION_SEC,
  type ReferenceBoundaries,
} from "./sections.js";
export { alignReferenceSections, MIN_ALIGNMENT_SCORE } from "./align.js";
export {
  deriveReferenceGaps,
  verifyReferenceProgress,
  REFERENCE_GAP_EPSILON,
  REFERENCE_GAP_METRICS,
  REFERENCE_GAP_REDUCTION_EPSILON,
  type DeriveGapsOptions,
} from "./gap.js";
export { deriveReferenceActions, MAX_REFERENCE_ACTIONS, MIN_ACTION_CONFIDENCE } from "./actions.js";
export {
  presentReferencePlanningContext,
  presentReferenceVerification,
  REFERENCE_CONTEXT_BUDGET,
} from "./present.js";

// ---------------------------------------------------------------------------
// Intelligence composition
// ---------------------------------------------------------------------------

/** Previous section (by array order) of `id`, or undefined at the start. */
function predecessorOf<T extends { sectionId?: string; id?: string }>(list: readonly T[], id: string): T | undefined {
  const idx = list.findIndex((s) => (s.sectionId ?? s.id) === id);
  return idx > 0 ? list[idx - 1] : undefined;
}

function gapsFor(
  current: SectionFeatures,
  currentSections: readonly SectionFeatures[],
  refSection: ReferenceSection,
  analysis: ReferenceAnalysis,
  alignmentConfidence?: number,
): ReferenceGap[] {
  return deriveReferenceGaps(current, refSection, {
    ...(alignmentConfidence !== undefined ? { alignmentConfidence } : {}),
    ...(predecessorOf(currentSections, current.sectionId)
      ? { currentPrev: predecessorOf(currentSections, current.sectionId) }
      : {}),
    ...(predecessorOf(analysis.sections, refSection.id)
      ? { referencePrev: predecessorOf(analysis.sections, refSection.id) }
      : {}),
  });
}

/**
 * Analysis + current sections → ReferenceIntelligence. With
 * `opts.targetSectionId` the alignment/gap/action derivation focuses on that
 * section (the goal's target); without it every alignable current section
 * gets an alignment and the best-scoring one drives the gaps.
 */
export function buildReferenceIntelligence(
  analysis: ReferenceAnalysis,
  currentSections: readonly SectionFeatures[],
  opts?: { targetSectionId?: string; referenceSectionId?: string },
): ReferenceIntelligence {
  const alignments = alignReferenceSections(currentSections, analysis, {
    ...(opts?.targetSectionId !== undefined ? { currentSectionId: opts.targetSectionId } : {}),
    ...(opts?.referenceSectionId !== undefined ? { referenceSectionId: opts.referenceSectionId } : {}),
  });

  const primary = alignments[0];
  const current = primary ? currentSections.find((s) => s.sectionId === primary.currentSectionId) : undefined;
  const refSection = primary ? analysis.sections.find((s) => s.id === primary.referenceSectionId) : undefined;
  const gaps =
    current && refSection ? gapsFor(current, currentSections, refSection, analysis, primary?.confidence) : [];
  const actions = deriveReferenceActions(gaps);
  const meaningful = gaps.filter((g) => g.direction === "higher_in_reference" || g.direction === "lower_in_reference");

  return {
    analysis,
    alignments,
    gaps,
    actions,
    coverage: {
      analysis: Math.round(analysis.coverage.featureCoverage * 100) / 100,
      alignment: primary?.score ?? 0,
      gap: Math.round((gaps.length / REFERENCE_GAP_METRICS.length) * 100) / 100,
      actionableGap: meaningful.length ? Math.round((actions.length / meaningful.length) * 100) / 100 : 0,
    },
  };
}

/**
 * The planner-facing slice for ONE resolved target. undefined when the
 * target has no alignment — the section context simply carries no reference
 * block (an honest "no honest match", never a fabricated pairing).
 */
export function buildReferencePlanningContext(
  target: SectionTarget,
  currentSections: readonly SectionFeatures[],
  refIntel: ReferenceIntelligence,
): ReferencePlanningContext | undefined {
  const current = currentSections.find((s) => s.sectionId === target.sectionId);
  if (!current) return undefined;
  const alignment = refIntel.alignments.find((a) => a.currentSectionId === target.sectionId);
  if (!alignment) return undefined;
  const refSection = refIntel.analysis.sections.find((s) => s.id === alignment.referenceSectionId);
  if (!refSection) return undefined;

  const gaps = gapsFor(current, currentSections, refSection, refIntel.analysis, alignment.confidence);
  const actions = deriveReferenceActions(gaps);

  return {
    currentSectionId: target.sectionId,
    referenceSectionId: refSection.id,
    comparison: gaps.map((g) => ({
      metric: g.metric,
      ...(g.current !== undefined ? { current: g.current.value } : {}),
      ...(g.reference !== undefined ? { reference: g.reference.value } : {}),
      ...(g.delta !== undefined ? { delta: g.delta } : {}),
      ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
    })),
    gaps,
    actions,
    coverage: Math.round((gaps.length / REFERENCE_GAP_METRICS.length) * 100) / 100,
  };
}
