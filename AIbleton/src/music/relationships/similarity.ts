/**
 * music/relationships/similarity.ts — pairwise section similarity.
 *
 * Repeat detection in feature space: every declared dimension contributes
 * 1 − |a−b| when BOTH sections know it, into the features layer's
 * weightedMean() — so similarity is always defined for a real pair (density
 * and activeTrackRatio always are) and confidence = evidence coverage,
 * which honestly drops on MIDI-only songs (audio dimensions absent).
 *
 * Note: for MIDI sections rhythmicActivity IS the normalized onset rate, so
 * it coincides with the density dimension there; for audio sections it is
 * the transient-derived signal. Accepted — similarity is a heuristic with
 * documented anchors, not a measurement.
 */

import {
  fv,
  normRange,
  ONSETS_PER_BAR_FULL,
  weightedMean,
} from "../features/normalize.js";
import type { WeightedComponent } from "../features/normalize.js";
import type { MusicalFeatures, SectionFeatures } from "../features/types.js";
import type { SectionSimilarity, SimilarityKind } from "./types.js";

/** similarity ≥ REPEAT → "repeat"; ≥ SIMILAR → "similar"; else "different".
 * Heuristic anchors — change deliberately, never incidentally. */
export const SIMILARITY_REPEAT = 0.9;
export const SIMILARITY_SIMILAR = 0.7;

/** Declared dimensions and weights. The total weight (7) is the
 * denominator of confidence; dimensions absent on either side drop out and
 * shrink the coverage honestly. */
const DIMENSIONS: readonly {
  get: (s: SectionFeatures) => number | undefined;
  w: number;
}[] = [
  { get: (s) => normRange(s.density, 0, ONSETS_PER_BAR_FULL), w: 1 },
  { get: (s) => s.activeTrackRatio, w: 1 },
  { get: (s) => s.rhythmicActivity?.value, w: 1 },
  { get: (s) => s.repetition, w: 1 },
  { get: (s) => s.lowEnergy?.value, w: 1 },
  { get: (s) => s.midEnergy?.value, w: 0.5 },
  { get: (s) => s.highEnergy?.value, w: 1 },
  { get: (s) => s.spectralBrightness?.value, w: 0.5 },
];

function classify(value: number): SimilarityKind {
  if (value >= SIMILARITY_REPEAT) return "repeat";
  if (value >= SIMILARITY_SIMILAR) return "similar";
  return "different";
}

export function buildSectionSimilarities(features: MusicalFeatures): SectionSimilarity[] {
  const sections = features.sections;
  const out: SectionSimilarity[] = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i];
      const b = sections[j];
      const components: WeightedComponent[] = DIMENSIONS.map((d) => {
        const va = d.get(a);
        const vb = d.get(b);
        return {
          v: va !== undefined && vb !== undefined ? 1 - Math.abs(va - vb) : undefined,
          w: d.w,
        };
      });
      const r = weightedMean(components);
      // density + activeTrackRatio are always defined, so r is never
      // undefined for a real pair — but never invent a number if that
      // invariant ever breaks.
      if (r === undefined) continue;
      out.push({
        aSectionId: a.sectionId,
        bSectionId: b.sectionId,
        similarity: fv(r.value, "derived", r.coverage),
        kind: classify(r.value),
      });
    }
  }
  return out;
}
