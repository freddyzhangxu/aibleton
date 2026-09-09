/**
 * music/reasoning/types.ts — public structures of the Music Reasoning Engine.
 *
 * Layer position:
 *
 *   MusicState (what is) → MusicalFeatures (comparable quantities)
 *                        → MusicalRelationships (how the quantities relate)
 *                        → MusicalReasoning (what is musically noteworthy)
 *                        → (future) Creative Actions
 *
 * Scope (PR13): deterministic, evidence-backed musical observations about
 * section transitions, arrangement structure, repetition/evolution, and
 * track/role co-activity. No LLM, no creative actions, no planner changes,
 * no Live tools — the LLM is a CONSUMER of these facts, never their author.
 *
 * Rules (enforced by construction, not convention):
 * - Pure: MusicalFeatures + MusicalRelationships in, observations out. This
 *   layer never touches MusicState and never recomputes a feature or a
 *   relationship: every number is read off features.sections[] /
 *   features.tracks[] / relationships.* fields only. (Non-adjacent section
 *   deltas for repetition/evolution are computed here from features —
 *   relationships.contrasts covers consecutive pairs only, by PR12 design.)
 * - Deterministic: same inputs → byte-identical output, every run. Emission
 *   order is fixed: section (transition order) → arrangement → repetition
 *   (pair order) → track.
 * - No LLM, no SDK, no filesystem, no network.
 *
 * Honesty rules — inherited from PR11/PR12:
 *
 * 1. undefined means "no reliable data" — NEVER faked as 0, and a missing
 *    input means NO observation. An unanalyzed audio section produces no
 *    energy observations at all; silence is the honest answer, not a
 *    fabricated "energy_flat".
 *
 * 2. Observations are NEUTRAL FACTS, not taste. "limited_energy_cycle"
 *    states that energy peaked and never came down; it never says the
 *    arrangement is bad. Judgement belongs to the LLM/user conversation.
 *
 * 3. strength and confidence are ORTHOGONAL:
 *    - strength  = magnitude of the musical effect (0-1, per-kind anchors
 *      documented in the compute files; e.g. an energy delta of 0.5 reads
 *      strength 1.0)
 *    - confidence = trust in the underlying data — weakest link (min) of
 *      the input FeatureValue confidences, exactly PR12's rule 3; omitted
 *      when no input carries one (MIDI facts have no confidence to inherit).
 *
 * 4. Every observation carries its evidence chain: machine-traversable
 *    feature paths ("sections[3].energy", "tracks[0].lowEnergy") with the
 *    raw values the classification stood on, so a consumer can always walk
 *    Observation → Evidence → MusicalFeatures → MusicState and answer
 *    "why do you say that?" without invoking a model.
 */

// ---------------------------------------------------------------------------
// Observation vocabulary (closed, versioned by the exported constants)
// ---------------------------------------------------------------------------

/** Consecutive-section transition observations (section.ts). */
export const SECTION_OBSERVATION_KINDS = [
  "energy_increase",
  "energy_decrease",
  "energy_flat",
  "density_increase",
  "density_decrease",
  "layer_increase",
  "layer_decrease",
  "rhythmic_increase",
  "rhythmic_decrease",
] as const;

/** Song-level arrangement observations (arrangement.ts). */
export const ARRANGEMENT_OBSERVATION_KINDS = [
  "clear_build",
  "clear_breakdown",
  "weak_contrast",
  "strong_contrast",
  "breakdown_after_peak",
  "energy_recovery",
  "repeated_peak",
  "limited_energy_cycle",
] as const;

/** Section-pair repetition observations (repetition.ts). */
export const REPETITION_OBSERVATION_KINDS = [
  "section_reprise",
  "repeated_section_low_variation",
  "repeated_section_with_evolution",
] as const;

/** Track/role co-activity observations (track.ts). */
export const TRACK_OBSERVATION_KINDS = [
  "strong_rhythmic_foundation",
  "low_frequency_co_activity",
] as const;

export const OBSERVATION_KINDS = [
  ...SECTION_OBSERVATION_KINDS,
  ...ARRANGEMENT_OBSERVATION_KINDS,
  ...REPETITION_OBSERVATION_KINDS,
  ...TRACK_OBSERVATION_KINDS,
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export interface ObservationEvidence {
  /** Machine-traversable path into MusicalFeatures, e.g. "sections[3].energy"
   * or "tracks[0].lowEnergy". Index-based: sections/tracks are addressed by
   * their array position (which equals their string id by construction). */
  metric: string;
  /** Value on the side the observation is ABOUT (sectionId / trackId). */
  value?: number;
  /** Value on the compared side (relatedSectionId / relatedTrackId). */
  relatedValue?: number;
  /** Signed change, value − relatedValue, in the metric's own units. */
  delta?: number;
}

export interface MusicalObservation {
  kind: ObservationKind;

  /** Section the observation is about (the "to" side of a transition, the
   * peak/trough/recovery section of an arc fact, the LATER section of a
   * repeated pair). */
  sectionId?: string;
  /** The compared section (the "from" side, the earlier pair member). */
  relatedSectionId?: string;

  trackId?: string;
  relatedTrackId?: string;

  /** 0-1: magnitude of the musical effect — per-kind anchors documented in
   * the compute files. NOT a quality score. */
  strength: number;
  /** 0-1: weakest-link of input FeatureValue confidences; omitted when no
   * input carries one (honesty rule 3). */
  confidence?: number;

  evidence: ObservationEvidence[];
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface MusicalReasoning {
  /** Fixed emission order: section (transition order) → arrangement →
   * repetition (pair order) → track. Same inputs → identical list. */
  observations: MusicalObservation[];
  coverage: {
    /** Total sections in the arrangement. */
    sections: number;
    /** Sections with a known energy — the share the energy-based
     *  observations stand on (mirrors the arc's energyCoverage honesty). */
    analyzedSections: number;
  };
}
