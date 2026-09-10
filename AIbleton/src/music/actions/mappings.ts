/**
 * music/actions/mappings.ts — the explicit, deterministic observation →
 * candidate tables. Everything this layer can possibly conclude lives here
 * as DATA, not as scattered conditionals.
 *
 * Two mapping classes, kept apart on purpose:
 *
 * A. SEMANTIC mappings — the observation itself implies a candidate
 *    intervention (weak_contrast → increase_section_contrast).
 *
 * B. COMBINATION mappings — a candidate fires only when a primary
 *    observation is backed by the ABSENCE/PRESENCE of another observation
 *    kind (weak_contrast + no layer_increase anywhere → increase_layering).
 *    This is the ONLY way directional observations participate: their
 *    absence/presence is read against the SAME analysis run, never as a
 *    naive inversion ("energy_decrease → increase_energy" is and stays
 *    forbidden — a decrease may be exactly what a breakdown needs).
 *
 * Absence gates are only ever placed on MIDI-derived directional kinds
 * (layer/density/rhythmic increase): those dimensions are measured on
 * every section of every song, so "no increase observation" is a real
 * measurement ("no transition grew on this axis"), not missing data. An
 * absence gate on an AUDIO-derived kind would read unanalyzed audio as
 * evidence — the unknown-stays-unknown rule forbids that.
 *
 * Deliberate silence is a mapping decision too: strong_contrast,
 * clear_build/breakdown, repeated_section_with_evolution,
 * breakdown_after_peak, energy_recovery, strong_rhythmic_foundation and
 * low_frequency_co_activity map to NOTHING. They stay valuable planner
 * evidence as observations; they are not intervention triggers.
 * low_frequency_co_activity in particular is spectral co-presence of
 * source files — with no post-mix audio feedback, "fix the low end" would
 * claim evidence the reasoning layer does not have.
 */

import type { ObservationKind } from "../reasoning/types.js";
import type {
  CreativeActionKind,
  CreativeActionTarget,
  CreativeDimension,
} from "./types.js";

// ---------------------------------------------------------------------------
// Candidate specs
// ---------------------------------------------------------------------------

export interface CandidateSpec {
  kind: CreativeActionKind;
  /** Structural breadth of the candidate (ids still come from the source
   * observation itself — a song-scope action may carry section ids for
   * provenance). */
  scope: NonNullable<CreativeActionTarget["scope"]>;
  /** Multiplier on the source observation's strength. Default 1 — a single
   * primary trigger preserves the observation's strength exactly. */
  strengthFactor?: number;
  /** Fire only when NO observation of this kind exists in the whole set
   * (combination class B — MIDI-derived directional kinds only, see header). */
  requiresAbsent?: ObservationKind;
  /** Fire only when an observation of this kind exists for the SAME section
   * pair (same sectionId + relatedSectionId) — "additional reasoning
   * suggests …" gates, e.g. a reprise that is also low-variation. */
  requiresCoObservation?: ObservationKind;
}

/** Strength multiplier for "possible, low-strength" candidates (reprise /
 * repeated peak → develop_section): the evidence suggests the option, it
 * does not press it. */
export const LOW_STRENGTH_FACTOR = 0.5;

export const OBSERVATION_MAPPINGS: Partial<Record<ObservationKind, CandidateSpec[]>> = {
  // A flat energy arc (PR13's song-level weak_contrast) is the one
  // observation that naturally implies contrast candidates. The primary is
  // structural; the three supporting candidates each need their OWN
  // independent evidence — the measured absence of any growth on that
  // MIDI-derived axis — so they never fire as a bundle by default.
  weak_contrast: [
    { kind: "increase_section_contrast", scope: "song" },
    { kind: "increase_layering", scope: "song", requiresAbsent: "layer_increase" },
    { kind: "increase_density", scope: "song", requiresAbsent: "density_increase" },
    {
      kind: "increase_rhythmic_activity",
      scope: "song",
      requiresAbsent: "rhythmic_increase",
    },
  ],

  // A repeat with no meaningful evolution: introduce variation in the
  // LATER section. introduce_variation (not develop_section) is the primary
  // here — the evidence specifically says LOW VARIATION (merge.ts enforces
  // that priority when both would land on the same pair).
  repeated_section_low_variation: [{ kind: "introduce_variation", scope: "section" }],

  // Peaked and never came down: the missing piece is a release, a
  // structural song-level candidate — never "turn the volume down".
  limited_energy_cycle: [{ kind: "strengthen_breakdown", scope: "song" }],

  // A plain reprise is not a problem. Only when the SAME pair is also
  // flagged low-variation does "develop the returning section" become a
  // candidate — at low strength, and subordinate to introduce_variation.
  section_reprise: [
    {
      kind: "develop_section",
      scope: "section",
      strengthFactor: LOW_STRENGTH_FACTOR,
      requiresCoObservation: "repeated_section_low_variation",
    },
  ],

  // The maximum reached more than once: the later peak could develop
  // rather than revisit — a gentle, low-strength candidate only.
  repeated_peak: [
    { kind: "develop_section", scope: "section", strengthFactor: LOW_STRENGTH_FACTOR },
  ],

  // Everything else is deliberately silent (see header): descriptive
  // directionals, healthy-arrangement facts, and observations the current
  // analysis depth cannot honestly turn into interventions.
};

// ---------------------------------------------------------------------------
// Dimension metadata — one axis per kind, fixed
// ---------------------------------------------------------------------------

export const KIND_DIMENSION: Record<CreativeActionKind, CreativeDimension> = {
  increase_energy: "energy",
  decrease_energy: "energy",
  increase_impact: "impact",
  reduce_impact: "impact",
  increase_density: "density",
  decrease_density: "density",
  increase_layering: "layering",
  decrease_layering: "layering",
  restore_layer: "layering",
  remove_layer: "layering",
  increase_rhythmic_activity: "rhythm",
  decrease_rhythmic_activity: "rhythm",
  introduce_rhythmic_variation: "rhythm",
  simplify_rhythm: "rhythm",
  increase_section_contrast: "contrast",
  reduce_section_contrast: "contrast",
  strengthen_build: "structure",
  strengthen_breakdown: "structure",
  introduce_variation: "variation",
  increase_repetition: "variation",
  develop_section: "variation",
};

// ---------------------------------------------------------------------------
// Opposition metadata — kinds that push the same dimension in opposite
// directions. Conflict resolution lives in merge.ts; the table lives here.
// ---------------------------------------------------------------------------

export const OPPOSITE_ACTIONS: Partial<Record<CreativeActionKind, CreativeActionKind>> = {
  increase_energy: "decrease_energy",
  decrease_energy: "increase_energy",
  increase_impact: "reduce_impact",
  reduce_impact: "increase_impact",
  increase_density: "decrease_density",
  decrease_density: "increase_density",
  increase_layering: "decrease_layering",
  decrease_layering: "increase_layering",
  increase_rhythmic_activity: "decrease_rhythmic_activity",
  decrease_rhythmic_activity: "increase_rhythmic_activity",
  introduce_rhythmic_variation: "simplify_rhythm",
  simplify_rhythm: "introduce_rhythmic_variation",
  increase_section_contrast: "reduce_section_contrast",
  reduce_section_contrast: "increase_section_contrast",
  increase_repetition: "introduce_variation",
  introduce_variation: "increase_repetition",
};

/** Opposing candidates on the same target whose strengths differ by AT
 * MOST this much are an effective tie — neither is surfaced. An arbitrary
 * winner (lexical order, emission order) would be taste, not evidence. */
export const OPPOSITION_TIE_EPS = 0.05;

/**
 * Subordination: when the evidence says LOW VARIATION, introduce_variation
 * is the precise candidate and develop_section the vague one — both derived
 * for the same section pair, the vague one drops. (Kind A wins over kind B
 * on identical sectionId + relatedSectionId.)
 */
export const SUBORDINATE_ACTIONS: Partial<Record<CreativeActionKind, CreativeActionKind>> = {
  develop_section: "introduce_variation",
};
