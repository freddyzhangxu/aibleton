/**
 * PR14 test fixtures: observation/reasoning literals (the layer consumes
 * MusicalReasoning, so literal data tests exactly that) plus a candidate
 * literal builder for merge/rank unit tests.
 */

import type {
  MusicalObservation,
  MusicalReasoning,
  ObservationKind,
} from "../../reasoning/types.js";
import type { CreativeAction, CreativeActionKind, CreativeActionTarget } from "../types.js";
import { KIND_DIMENSION } from "../mappings.js";

/** A MusicalObservation literal — strength required, everything else
 * opt-in, evidence empty unless the test cares about it. */
export function obs(
  kind: ObservationKind,
  strength: number,
  over: Partial<MusicalObservation> = {},
): MusicalObservation {
  return {
    kind,
    strength,
    ...(over.sectionId !== undefined ? { sectionId: over.sectionId } : {}),
    ...(over.relatedSectionId !== undefined
      ? { relatedSectionId: over.relatedSectionId }
      : {}),
    ...(over.trackId !== undefined ? { trackId: over.trackId } : {}),
    ...(over.relatedTrackId !== undefined
      ? { relatedTrackId: over.relatedTrackId }
      : {}),
    ...(over.confidence !== undefined ? { confidence: over.confidence } : {}),
    evidence: over.evidence ?? [],
  };
}

export function reasoningOf(observations: MusicalObservation[]): MusicalReasoning {
  return { observations, coverage: { sections: 0, analyzedSections: 0 } };
}

/** A CreativeAction literal for merge/rank unit tests — bypasses derivation
 * so those stages are tested against exactly the inputs they document. */
export function candidate(
  kind: CreativeActionKind,
  strength: number,
  target: CreativeActionTarget = {},
  over: Partial<CreativeAction> = {},
): CreativeAction {
  return {
    kind,
    target,
    strength,
    ...(over.confidence !== undefined ? { confidence: over.confidence } : {}),
    sourceObservations: over.sourceObservations ?? [obs("weak_contrast", strength)],
    dimension: over.dimension ?? KIND_DIMENSION[kind],
  };
}
