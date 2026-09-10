/**
 * music/actions/types.ts — public structures of the Creative Action Library.
 *
 * Layer position:
 *
 *   MusicState → MusicalFeatures → MusicalRelationships → MusicalReasoning
 *              → CreativeActions (this layer) → Planner → Live Tools
 *
 * The division of labor this layer exists to keep apart:
 *
 *   MusicalReasoning describes WHAT IS HAPPENING (neutral facts).
 *   CreativeActions describe WHAT MUSICAL DIRECTION COULD BE TAKEN
 *     (evidence-backed candidate interventions).
 *   The Planner decides WHAT TO ACTUALLY DO (goal-dependent judgement).
 *   Ableton Tools decide HOW TO EXECUTE IT.
 *
 * Rules (enforced by construction, not convention):
 * - Pure: MusicalReasoning in, CreativeActionSet out. No MusicState, no
 *   features, no SDK, no filesystem, no network, no LLM, no async.
 * - Deterministic: same reasoning in → byte-identical set out, every run.
 * - Evidence-backed: every action carries ≥1 source observation — the
 *   "why was this proposed?" chain (action → observation → evidence →
 *   features → MusicState) never needs a model to answer.
 * - Recommendation, not judgement: an action says "candidate", never
 *   "must". The LLM/user keeps creative judgement.
 * - Honest (PR11–PR13 rules unchanged): a missing observation means NO
 *   action — unknown is never converted into evidence. strength ⊥
 *   confidence exactly as in reasoning: strength is how strongly the
 *   evidence supports surfacing the candidate (NOT an artistic quality
 *   score); confidence is inherited trust in the underlying data, omitted
 *   when the sources carry none.
 * - Semantic, not implementation: the vocabulary names musical directions
 *   (increase_layering), never Live operations (duplicate_clip). Choosing
 *   tools is the Planner's job.
 *
 * Directional observations (energy_increase, rhythmic_decrease, …) are
 * descriptive facts and are NEVER inverted into corrective actions here —
 * "energy went down" does not imply "energy should go up"; a decrease may
 * be exactly what a breakdown needs. They may only SUPPORT a candidate
 * through an explicit combination mapping (see mappings.ts).
 */

import type { MusicalObservation } from "../reasoning/types.js";

// ---------------------------------------------------------------------------
// Action vocabulary (closed, versioned by the exported constant)
// ---------------------------------------------------------------------------

export const CREATIVE_ACTION_KINDS = [
  // Energy / impact
  "increase_energy",
  "decrease_energy",
  "increase_impact",
  "reduce_impact",

  // Density / layering
  "increase_density",
  "decrease_density",
  "increase_layering",
  "decrease_layering",
  "restore_layer",
  "remove_layer",

  // Rhythm
  "increase_rhythmic_activity",
  "decrease_rhythmic_activity",
  "introduce_rhythmic_variation",
  "simplify_rhythm",

  // Arrangement
  "increase_section_contrast",
  "reduce_section_contrast",
  "strengthen_build",
  "strengthen_breakdown",

  // Repetition / evolution
  "introduce_variation",
  "increase_repetition",
  "develop_section",
] as const;

export type CreativeActionKind = (typeof CREATIVE_ACTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Dimension — the musical axis an action pushes on. Opposing candidates are
// only ever compared within one dimension (merge.ts).
// ---------------------------------------------------------------------------

export type CreativeDimension =
  | "energy"
  | "impact"
  | "density"
  | "layering"
  | "rhythm"
  | "contrast"
  | "structure"
  | "variation";

// ---------------------------------------------------------------------------
// Target — IDs are canonical (the reasoning model's own section/track ids);
// names never appear here. All fields optional: a song-scope action may
// legitimately point at nothing narrower than the whole arrangement.
// ---------------------------------------------------------------------------

export interface CreativeActionTarget {
  /** Section the action is about (mirrors the source observation's
   * sectionId — the "to" side, the later/repeated section). */
  sectionId?: string;
  /** The compared section (the "from" side, the earlier pair member). */
  relatedSectionId?: string;

  trackId?: string;
  relatedTrackId?: string;

  scope?: "section" | "transition" | "track" | "song";
}

// ---------------------------------------------------------------------------
// CreativeAction
// ---------------------------------------------------------------------------

export interface CreativeAction {
  kind: CreativeActionKind;

  target: CreativeActionTarget;

  /** 0-1: how strongly the available reasoning supports surfacing this
   * candidate. NOT an artistic quality score. */
  strength: number;

  /** 0-1: inherited from the source observation(s) — weakest link on merge.
   * Omitted when no source carries confidence metadata (never faked as 1). */
  confidence?: number;

  /** The reasoning facts that caused this candidate to exist. NEVER empty —
   * an action without provenance is a fabricated one. */
  sourceObservations: MusicalObservation[];

  /** The musical axis this action pushes on — groups competing/opposite
   * candidates so contradictory spam can be resolved deterministically. */
  dimension?: CreativeDimension;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface CreativeActionSet {
  /** Deterministically ranked and capped (see rank.ts). Zero is valid:
   *  "nothing to suggest" is an honest answer. */
  actions: CreativeAction[];

  coverage: {
    /** Observations the reasoning layer emitted. */
    sourceObservations: number;
    /** Observations whose kind this layer has at least one candidate
     *  mapping for — the share PR14 can read at all (mapped ≠ emitted:
     *  gates may still silence a mapped observation). */
    actionableObservations: number;
  };
}
