/**
 * music/sections/index.ts — the Section-aware Agent layer, one import site.
 *
 *   MusicGoal + MusicIntelligence → buildSectionPlanningContext
 *   SectionPlanningContext        → presentSectionPlanningContext (tool result)
 *   before/after contexts         → verifySectionChange (goal-gate evidence)
 *
 * Orchestration/contextualization only — no new music analysis lives here
 * (features/relationships/reasoning/actions stay the single producers).
 * Pure, deterministic, unknown-safe; the agent falls back to the song-level
 * goal projection whenever a target cannot be resolved.
 */

export {
  normalizeSectionLabel,
  sectionRole,
  parseSectionOrdinalTarget,
  resolveSectionTarget,
  matchTargetSectionAfter,
} from "./resolve.js";
export type { SectionOrdinalTarget } from "./resolve.js";

export { MAX_SECTION_REFERENCES, selectSectionReferences } from "./reference.js";

export {
  MAX_SECTION_ACTIONS,
  MAX_SECTION_OBSERVATIONS,
  SECTION_CONTEXT_BUDGET,
  buildSectionPlanningContext,
  presentSectionPlanningContext,
} from "./context.js";

export {
  SECTION_DELTA_THRESHOLDS,
  presentSectionVerification,
  projectSectionVerificationCriteria,
  verifySectionChange,
} from "./verify.js";

export type {
  SectionCriterionResult,
  SectionFeatureProjection,
  SectionMatchKind,
  SectionPlanningContext,
  SectionReference,
  SectionReferenceReason,
  SectionRelationshipChange,
  SectionTarget,
  SectionTargetResolution,
  SectionVerification,
  SectionVerificationCriterion,
  SectionVerificationDirection,
  SectionVerificationMetric,
  SectionVerificationStatus,
} from "./types.js";
