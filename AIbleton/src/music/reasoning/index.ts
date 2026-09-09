/**
 * music/reasoning/index.ts — the Music Reasoning Engine, one import site.
 *
 *   MusicalFeatures + MusicalRelationships → buildMusicalReasoning → MusicalReasoning
 *
 * PR13 scope: deterministic, evidence-backed musical observations about
 * section transitions, arrangement structure, repetition/evolution, and
 * track/role co-activity. Pure, deterministic, no LLM, read-only — consumes
 * MusicalFeatures + MusicalRelationships ONLY (never MusicState). See
 * types.ts for the honesty rules (undefined = no observation; neutral facts,
 * never taste; strength ⊥ confidence; evidence chains are machine-
 * traversable). No server wiring yet (same landing pattern as PR11/PR12).
 */

import { buildArrangementObservations } from "./arrangement.js";
import { buildRepetitionObservations } from "./repetition.js";
import { buildSectionObservations } from "./section.js";
import { buildTrackObservations } from "./track.js";
import type { MusicalFeatures } from "../features/types.js";
import type { MusicalRelationships } from "../relationships/types.js";
import type { MusicalReasoning } from "./types.js";

export {
  ENERGY_CYCLE_FALL,
  PEAK_EPS,
  STRONG_CONTRAST_RANGE,
  buildArrangementObservations,
} from "./arrangement.js";
export { EVOLUTION_EPS, EVOLUTION_FULL, buildRepetitionObservations } from "./repetition.js";
export {
  SECTION_DENSITY_EPS,
  SECTION_FULL_DELTA,
  SECTION_LAYER_EPS,
  SECTION_RHYTHMIC_EPS,
  buildSectionObservations,
} from "./section.js";
export {
  CO_ACTIVITY_ACTIVE_RATIO,
  FOUNDATION_ACTIVE_RATIO,
  LOW_ENERGY_CO_ACTIVITY,
  buildTrackObservations,
} from "./track.js";
export {
  ARRANGEMENT_OBSERVATION_KINDS,
  OBSERVATION_KINDS,
  REPETITION_OBSERVATION_KINDS,
  SECTION_OBSERVATION_KINDS,
  TRACK_OBSERVATION_KINDS,
} from "./types.js";
export type {
  MusicalObservation,
  MusicalReasoning,
  ObservationEvidence,
  ObservationKind,
} from "./types.js";

export function buildMusicalReasoning(
  features: MusicalFeatures,
  relationships: MusicalRelationships,
): MusicalReasoning {
  return {
    // Fixed emission order: section (transition order) → arrangement →
    // repetition (pair order) → track. Same inputs → identical output.
    observations: [
      ...buildSectionObservations(features, relationships),
      ...buildArrangementObservations(features, relationships),
      ...buildRepetitionObservations(features, relationships),
      ...buildTrackObservations(features),
    ],
    coverage: {
      sections: features.sections.length,
      analyzedSections: features.sections.filter((s) => s.energy !== undefined).length,
    },
  };
}
