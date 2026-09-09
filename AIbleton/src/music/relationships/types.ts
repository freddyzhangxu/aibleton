/**
 * music/relationships/types.ts — public structures of Musical Relationships.
 *
 * Layer position:
 *
 *   MusicState (what is) → MusicalFeatures (comparable quantities)
 *                        → MusicalRelationships (how the quantities relate)
 *                        → (future) Reasoning → Creative Actions
 *
 * Scope (PR12): section↔section relationships + the song-level arrangement
 * arc ONLY. Track↔track and track↔section relationships are future PRs and
 * are deliberately not stubbed here.
 *
 * Rules (enforced by construction, not convention):
 * - Pure: MusicalFeatures in, relationships out. This layer never touches
 *   MusicState and never recomputes a feature: every number is derived from
 *   features.sections[] / features.song fields only.
 * - Deterministic: same MusicalFeatures → identical relationships, every run.
 * - No LLM, no SDK, no filesystem, no network.
 *
 * Honesty rules — PR11's two (inherited) plus two of our own:
 *
 * 1. undefined means "no reliable data" — NEVER faked as 0. A section pair
 *    whose energy is unknown on either side has energyDelta === undefined,
 *    so a consumer reads "energy change unknown", not "energy unchanged".
 *
 * 2. Deltas/similarities are HEURISTIC combinations, not music-theoretic
 *    truth — they ship as FeatureValue with source "derived".
 *
 * 3. Two-input combinations carry confidence = min(input confidences) —
 *    the weakest link; omitted when neither input carries one.
 *
 * 4. Multi-dimension combinations carry confidence = evidence coverage via
 *    the features layer's weightedMean() — the exact PR11 discipline.
 *
 * Structural outputs (kind classifications, sectionId references, the
 * energy-curve projection) are facts of structure, not quantities — they
 * are NOT wrapped in FeatureValue. Every kind vocabulary below is a
 * heuristic classification with documented anchors (see the compute files),
 * not music-theoretic ground truth.
 */

import type { FeatureValue } from "../features/types.js";

// ---------------------------------------------------------------------------
// Consecutive-section contrast
// ---------------------------------------------------------------------------

export const CONTRAST_KINDS = ["rise", "fall", "steady"] as const;
export type ContrastKind = (typeof CONTRAST_KINDS)[number];

export interface SectionContrast {
  fromSectionId: string;
  toSectionId: string;
  /** to.energy − from.energy (−1..1, signed). source "derived", confidence =
   * min of the two energy confidences. undefined when EITHER section's
   * energy is unknown — never substituted by density (rule 1). */
  energyDelta?: FeatureValue;
  /** Raw onsets/bar delta. density is always defined on SectionFeatures
   * (0 is a real fact), so this delta is always defined. */
  densityDelta: number;
  activeTrackRatioDelta: number;
  /** Classification of the PRIMARY signal: energyDelta when defined, else
   * the normRange-normalized density delta. `basis` records which signal
   * `kind` was classified on. */
  kind: ContrastKind;
  basis: "energy" | "density";
}

// ---------------------------------------------------------------------------
// Pairwise section similarity (repeat detection)
// ---------------------------------------------------------------------------

export const SIMILARITY_KINDS = ["repeat", "similar", "different"] as const;
export type SimilarityKind = (typeof SIMILARITY_KINDS)[number];

export interface SectionSimilarity {
  /** Unordered pair, aSectionId < bSectionId numerically; one entry per pair. */
  aSectionId: string;
  bSectionId: string;
  /** 1 − weightedMean(per-dimension |a−b|) over the dimensions BOTH sections
   * have data for. Always defined for a real pair (density and
   * activeTrackRatio always are); source "derived"; confidence = coverage,
   * which honestly drops on MIDI-only songs (audio dims absent). */
  similarity: FeatureValue;
  kind: SimilarityKind;
}

// ---------------------------------------------------------------------------
// Song-level arrangement arc
// ---------------------------------------------------------------------------

export const ARC_KINDS = ["flat", "build", "breakdown", "arch", "valley", "irregular"] as const;
export type ArcKind = (typeof ARC_KINDS)[number];

export interface ArrangementArc {
  /** Projection of sections[].energy?.value, parallel to sections[].
   * undefined entries = sections whose energy is unknown (rule 1). */
  energyCurve: (number | undefined)[];
  /** Share of sections with a known energy (0 when there are no sections).
   * A shape classified on 2 of 6 sections says so here. */
  energyCoverage: number;
  /** undefined when fewer than 2 sections have a known energy. "irregular"
   * is the honest "none of the named shapes", not a failure. */
  kind?: ArcKind;
  /** Earliest section at maximum energy; undefined when no section has a
   * known energy. */
  peakSectionId?: string;
  /** 0-1: peak section midpoint ÷ song duration. Omitted when the
   * arrangement has no duration. */
  peakPosition?: number;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface MusicalRelationships {
  /** sections.length − 1 entries, in arrangement order. */
  contrasts: SectionContrast[];
  /** All unordered section pairs. */
  similarities: SectionSimilarity[];
  arc: ArrangementArc;
}
