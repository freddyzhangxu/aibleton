/**
 * music/relationships/contrast.ts — consecutive-section contrast.
 *
 * Reads features.sections[] only. The primary signal is the energy delta,
 * used only when BOTH sections know their energy; density is the declared
 * fallback, never a silent substitute — energyDelta stays undefined when
 * either side lacks energy, and `basis` says which signal `kind` classified.
 */

import {
  fv,
  normRange,
  ONSETS_PER_BAR_FULL,
} from "../features/normalize.js";
import type { FeatureValue, MusicalFeatures } from "../features/types.js";
import type { ContrastKind, SectionContrast } from "./types.js";

/** |signal| at or below which a transition reads "steady" (0-1 scale of
 * energy / normalized density). Heuristic anchor — change deliberately,
 * never incidentally. */
export const CONTRAST_EPS = 0.1;

/** min of the defined confidences; undefined when neither carries one. */
function minConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function classify(signal: number): ContrastKind {
  if (signal > CONTRAST_EPS) return "rise";
  if (signal < -CONTRAST_EPS) return "fall";
  return "steady";
}

export function buildSectionContrasts(features: MusicalFeatures): SectionContrast[] {
  const sections = features.sections;
  const out: SectionContrast[] = [];
  for (let i = 0; i + 1 < sections.length; i++) {
    const from = sections[i];
    const to = sections[i + 1];

    const energyDelta: FeatureValue | undefined =
      from.energy !== undefined && to.energy !== undefined
        ? fv(
            to.energy.value - from.energy.value,
            "derived",
            minConfidence(from.energy.confidence, to.energy.confidence),
          )
        : undefined;

    let basis: "energy" | "density";
    let signal: number;
    if (energyDelta !== undefined) {
      basis = "energy";
      signal = energyDelta.value;
    } else {
      basis = "density";
      signal =
        normRange(to.density, 0, ONSETS_PER_BAR_FULL) -
        normRange(from.density, 0, ONSETS_PER_BAR_FULL);
    }

    out.push({
      fromSectionId: from.sectionId,
      toSectionId: to.sectionId,
      ...(energyDelta !== undefined ? { energyDelta } : {}),
      densityDelta: to.density - from.density,
      activeTrackRatioDelta: to.activeTrackRatio - from.activeTrackRatio,
      kind: classify(signal),
      basis,
    });
  }
  return out;
}
