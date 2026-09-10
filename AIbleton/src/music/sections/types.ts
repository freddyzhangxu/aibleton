/**
 * music/sections/types.ts — public structures of the Section-aware Agent layer.
 *
 * Layer position:
 *
 *   MusicState → MusicalFeatures → MusicalRelationships → MusicalReasoning
 *              → CreativeActions → MusicIntelligence
 *              → SectionTarget (WHERE the goal applies)
 *              → SectionPlanningContext (WHAT the planner should see)
 *              → SectionVerification (DID the target actually change)
 *
 * This is an orchestration/contextualization layer, NOT a new music-analysis
 * layer: it never recomputes density/energy/repetition/contrast/similarity —
 * every number is read off MusicIntelligence. Three separations are kept on
 * purpose (PR16 reference tracks will plug into reference/context without
 * touching resolution or verification):
 *
 *   resolve.ts   — deterministic goal → target section
 *   context.ts   — target + references → compact planner context
 *   verify.ts    — before/after target → goal-aware verdict
 *
 * Rules (enforced by construction, not convention):
 * - Pure: MusicGoal + MusicIntelligence in, structures out. No Live SDK, no
 *   server, no model, no I/O, no Date.now(), no Math.random().
 * - Deterministic: same goal + intelligence → identical target, references,
 *   context, criteria and verdict, every run.
 * - Honest (PR11–14 rules unchanged): undefined stays undefined — an
 *   unmeasured metric is "unknown", never 0; an unmatched goal target is
 *   "matched: false", never a fabricated section.
 * - Target-centric, not target-isolated: references (previous / next /
 *   same-role / reprise / contrast partners) are COMPARISON anchors, not
 *   automatic edit targets.
 */

import type { FeatureValue, SectionFeatures } from "../features/types.js";
import type { MusicalObservation } from "../reasoning/types.js";
import type { CreativeAction } from "../actions/types.js";

// ---------------------------------------------------------------------------
// Section target resolution
// ---------------------------------------------------------------------------

/** How the target was found — fixed confidence per kind (resolve.ts), so the
 * planner can read "how sure is the server about WHERE to edit". */
export type SectionMatchKind =
  | "id" // explicit section id ("3" / "section_3")
  | "label" // exact cue/label, case-insensitive
  | "normalized_label" // "drop_2" / "DROP-2" / "Drop #2" → "Drop 2"
  | "ordinal" // "second drop" / "drop 2" / "last chorus"
  | "goal" // resolved from criteria-named sections or substring match
  | "fallback"; // weak/positional match (post-execution re-match)

export interface SectionTarget {
  sectionId: string;
  /** Cue name or "bars N-M" label, echoed for the planner. */
  name: string;
  startBeat: number;
  endBeat: number;
  match: SectionMatchKind;
  /** 0-1, fixed per match kind — never random, never model-judged. */
  confidence: number;
  /** The goal's own words that led here (debugging echo). */
  requested?: string;
}

/** Discriminated union: an unresolved target is a first-class answer
 * ("chorus" in a song without one), never an invented section. */
export type SectionTargetResolution =
  | { matched: true; target: SectionTarget }
  | { matched: false; requested?: string };

// ---------------------------------------------------------------------------
// Internal section references (current Live Set ONLY — external reference
// tracks are PR16 and deliberately not stubbed here)
// ---------------------------------------------------------------------------

export type SectionReferenceReason =
  | "previous" // arrangement neighbour before the target
  | "next" // arrangement neighbour after the target
  | "same_role" // same normalized label role ("Drop 1" for target "Drop 2")
  | "similar" // relationships layer says the pair is similar
  | "contrast" // comparison anchor (criteria partner or strong contrast)
  | "reprise" // relationships layer kind "repeat" partner
  | "peak" // arrangement energy peak
  | "song_context"; // reserved for song-level anchoring

export interface SectionReference {
  sectionId: string;
  /** Cue/label echo — verification re-matches by name when ids drift. */
  name: string;
  reason: SectionReferenceReason;
  /** 0-1 deterministic ranking score (reference.ts) — NOT a quality score. */
  relevance: number;
  /** Echoed when the pair has one — unknown stays undefined, never 0. */
  similarity?: number;
  contrast?: number;
}

// ---------------------------------------------------------------------------
// Section planning context
// ---------------------------------------------------------------------------

/** The goal-relevant feature slice of the target section. Fields are
 * REFERENCES into the source SectionFeatures — selected, never recomputed.
 * Which fields appear is a deterministic function of the goal's criteria and
 * the selected actions (context.ts); absent = not goal-relevant OR no data
 * (the two cases read identically downstream: "not provided"). */
export interface SectionFeatureProjection {
  energy?: FeatureValue;
  /** Raw onsets/bar (always defined on SectionFeatures — 0 is a real fact). */
  density?: number;
  activeTrackRatio?: number;
  repetition?: number;
  variation?: number;
  rhythmicActivity?: FeatureValue;
  lowEnergy?: FeatureValue;
  midEnergy?: FeatureValue;
  highEnergy?: FeatureValue;
  impact?: FeatureValue;
  tension?: FeatureValue;
  release?: FeatureValue;
}

export interface SectionPlanningContext {
  target: SectionTarget;

  /** Comparison anchors, ranked by relevance (ties: beat position, then id);
   * never contains the target itself. */
  references: SectionReference[];

  /** Goal-relevant feature slice of the target (presentation + verification). */
  features: SectionFeatureProjection;

  /** The target's full feature row — verification reads every metric from
   * here regardless of what the projection selected for presentation. */
  targetFeatures: SectionFeatures;

  /** Observations about the target or a selected reference, ranked
   * strength × (confidence ?? 1), ties keep emission order; capped. */
  observations: MusicalObservation[];

  /** Creative actions touching the target (then references, then song-scope),
   * in the action layer's own ranked order; capped. Hints, never commands. */
  actions: CreativeAction[];

  song: {
    tempo?: number;
    durationBeats?: number;
    sectionCount: number;
  };

  coverage: {
    featureCoverage: number; // share of projection fields with data
    observationCount: number;
    actionCount: number;
  };
}

// ---------------------------------------------------------------------------
// Section verification
// ---------------------------------------------------------------------------

/** Metrics a section verdict can be computed on. contrast/similarity are
 * RELATIVE metrics (target vs a reference) — "make the drop hit harder" is
 * about Build→Drop contrast, not Drop energy alone. */
export type SectionVerificationMetric =
  | "energy"
  | "density"
  | "active_track_ratio"
  | "variation"
  | "repetition"
  | "rhythmic_activity"
  | "impact"
  | "contrast"
  | "similarity";

export type SectionVerificationDirection = "increase" | "decrease" | "maintain";

export type SectionVerificationStatus = "passed" | "failed" | "unknown";

export interface SectionVerificationCriterion {
  metric: SectionVerificationMetric;
  direction: SectionVerificationDirection;
  /** From the goal's own criteria → gates the verdict. From creative actions
   * → supporting evidence only (Goal > Creative Actions, always). */
  required: boolean;
  weight: number;
  /** The reference section a contrast/similarity criterion compares against. */
  referenceSectionId?: string;
}

export interface SectionCriterionResult {
  metric: SectionVerificationMetric;
  direction: SectionVerificationDirection;
  required: boolean;
  /** The criterion's own weight (goal criteria 1, action-derived = action
   * strength) — echoed so presentation/retry surfaces can rank without
   * recomputing the projection. */
  weight: number;
  before?: number;
  after?: number;
  delta?: number;
  status: SectionVerificationStatus;
  /** weakest-link (min) of before/after confidences; omitted when neither
   * side carries one. */
  confidence?: number;
  referenceSectionId?: string;
}

export interface SectionRelationshipChange {
  referenceSectionId: string;
  metric: "contrast" | "similarity";
  before?: number;
  after?: number;
  delta?: number;
}

export interface SectionVerification {
  status: SectionVerificationStatus;
  target: {
    beforeSectionId: string;
    /** undefined when the target could not be re-matched after execution. */
    afterSectionId?: string;
  };
  matchedAfter: boolean;
  criteria: SectionCriterionResult[];
  relationshipChanges: SectionRelationshipChange[];
  /** weakest-link across judged criteria; omitted when nothing carried one. */
  confidence?: number;
}
