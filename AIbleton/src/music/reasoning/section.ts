/**
 * music/reasoning/section.ts — observations about consecutive-section
 * transitions.
 *
 * One pass over relationships.contrasts (which is parallel to consecutive
 * section pairs, in arrangement order). Per transition, at most ONE energy
 * observation (increase / decrease / flat — exactly one always fires when
 * both sections know their energy) plus one observation per secondary
 * dimension (density, layer, rhythmic) whose |delta| exceeds its threshold.
 * Emission order within a transition is fixed: energy → density → layer →
 * rhythmic.
 *
 * Honesty: when either section's energy is unknown there is NO energy
 * observation at all — not a fabricated "flat" (rule 1). Rhythmic fires
 * only when both sections carry rhythmicActivity. density and
 * activeTrackRatio are always-defined MIDI facts, so their observations
 * carry no confidence (there is none to inherit).
 */

import { clamp01, normRange, ONSETS_PER_BAR_FULL } from "../features/normalize.js";
import type { MusicalFeatures } from "../features/types.js";
import { CONTRAST_EPS } from "../relationships/contrast.js";
import type { MusicalRelationships } from "../relationships/types.js";
import type { MusicalObservation, ObservationKind } from "./types.js";

/** Normalized density delta (16 onsets/bar = 1.0) beyond which a transition
 * reads as a density change. Heuristic anchor — change deliberately. */
export const SECTION_DENSITY_EPS = 0.1;
/** activeTrackRatio delta beyond which a transition reads as a layer change. */
export const SECTION_LAYER_EPS = 0.1;
/** rhythmicActivity delta beyond which a transition reads as a rhythmic change. */
export const SECTION_RHYTHMIC_EPS = 0.1;
/** |delta| that maps to strength 1.0 for every section-transition signal
 * (all four live on a 0-1 scale; a half-scale swing is a maximal effect). */
export const SECTION_FULL_DELTA = 0.5;

/** min of the defined confidences; undefined when neither carries one. */
function minConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function buildSectionObservations(
  features: MusicalFeatures,
  relationships: MusicalRelationships,
): MusicalObservation[] {
  const out: MusicalObservation[] = [];
  for (const c of relationships.contrasts) {
    // sectionId IS the array index as a string (features/types.ts invariant).
    const from = features.sections[Number(c.fromSectionId)];
    const to = features.sections[Number(c.toSectionId)];
    const ref = { sectionId: to.sectionId, relatedSectionId: from.sectionId };

    // --- energy (exactly one observation when both sides know it) ---
    if (c.energyDelta !== undefined) {
      const d = c.energyDelta.value;
      const kind: ObservationKind =
        d > CONTRAST_EPS ? "energy_increase" : d < -CONTRAST_EPS ? "energy_decrease" : "energy_flat";
      // For flat, strength is "how flat": 1 at exactly 0, → 0 at the threshold.
      const strength =
        kind === "energy_flat"
          ? 1 - clamp01(Math.abs(d) / CONTRAST_EPS)
          : clamp01(Math.abs(d) / SECTION_FULL_DELTA);
      out.push({
        kind,
        ...ref,
        strength,
        ...(c.energyDelta.confidence !== undefined
          ? { confidence: c.energyDelta.confidence }
          : {}),
        evidence: [
          {
            metric: `sections[${to.sectionId}].energy`,
            value: to.energy?.value,
            relatedValue: from.energy?.value,
            delta: d,
          },
        ],
      });
    }

    // --- density (normalized for classification, raw in evidence) ---
    const densityDeltaN =
      normRange(to.density, 0, ONSETS_PER_BAR_FULL) -
      normRange(from.density, 0, ONSETS_PER_BAR_FULL);
    if (Math.abs(densityDeltaN) > SECTION_DENSITY_EPS) {
      out.push({
        kind: densityDeltaN > 0 ? "density_increase" : "density_decrease",
        ...ref,
        strength: clamp01(Math.abs(densityDeltaN) / SECTION_FULL_DELTA),
        evidence: [
          {
            metric: `sections[${to.sectionId}].density`,
            value: to.density,
            relatedValue: from.density,
            delta: c.densityDelta,
          },
        ],
      });
    }

    // --- layer (activeTrackRatio) ---
    const layerDelta = c.activeTrackRatioDelta;
    if (Math.abs(layerDelta) > SECTION_LAYER_EPS) {
      out.push({
        kind: layerDelta > 0 ? "layer_increase" : "layer_decrease",
        ...ref,
        strength: clamp01(Math.abs(layerDelta) / SECTION_FULL_DELTA),
        evidence: [
          {
            metric: `sections[${to.sectionId}].activeTrackRatio`,
            value: to.activeTrackRatio,
            relatedValue: from.activeTrackRatio,
            delta: layerDelta,
          },
        ],
      });
    }

    // --- rhythmic (only when BOTH sections carry the signal) ---
    if (from.rhythmicActivity !== undefined && to.rhythmicActivity !== undefined) {
      const d = to.rhythmicActivity.value - from.rhythmicActivity.value;
      if (Math.abs(d) > SECTION_RHYTHMIC_EPS) {
        const confidence = minConfidence(
          from.rhythmicActivity.confidence,
          to.rhythmicActivity.confidence,
        );
        out.push({
          kind: d > 0 ? "rhythmic_increase" : "rhythmic_decrease",
          ...ref,
          strength: clamp01(Math.abs(d) / SECTION_FULL_DELTA),
          ...(confidence !== undefined ? { confidence } : {}),
          evidence: [
            {
              metric: `sections[${to.sectionId}].rhythmicActivity`,
              value: to.rhythmicActivity.value,
              relatedValue: from.rhythmicActivity.value,
              delta: d,
            },
          ],
        });
      }
    }
  }
  return out;
}
