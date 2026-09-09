/**
 * music/relationships/index.ts — Musical Relationships, one import site.
 *
 *   MusicState → MusicalFeatures → buildMusicalRelationships → MusicalRelationships
 *
 * PR12 scope: section↔section relationships (contrast, similarity) + the
 * song-level arrangement arc. Pure, deterministic, no LLM, read-only —
 * consumes MusicalFeatures ONLY (never MusicState, never recomputes a
 * feature). See types.ts for the honesty and provenance rules. No server
 * wiring yet (same landing pattern as PR11).
 */

import { buildArrangementArc } from "./arc.js";
import { buildSectionContrasts } from "./contrast.js";
import { buildSectionSimilarities } from "./similarity.js";
import type { MusicalFeatures } from "../features/types.js";
import type { MusicalRelationships } from "./types.js";

export { ARC_FLAT_RANGE, ARC_STEP_EPS, buildArrangementArc } from "./arc.js";
export { buildSectionContrasts, CONTRAST_EPS } from "./contrast.js";
export {
  buildSectionSimilarities,
  SIMILARITY_REPEAT,
  SIMILARITY_SIMILAR,
} from "./similarity.js";
export { ARC_KINDS, CONTRAST_KINDS, SIMILARITY_KINDS } from "./types.js";
export type {
  ArcKind,
  ArrangementArc,
  ContrastKind,
  MusicalRelationships,
  SectionContrast,
  SectionSimilarity,
  SimilarityKind,
} from "./types.js";

export function buildMusicalRelationships(features: MusicalFeatures): MusicalRelationships {
  return {
    contrasts: buildSectionContrasts(features),
    similarities: buildSectionSimilarities(features),
    arc: buildArrangementArc(features),
  };
}
