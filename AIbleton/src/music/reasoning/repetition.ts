/**
 * music/reasoning/repetition.ts — what pairwise section similarity MEANS.
 *
 * relationships.similarities says "these two sections look alike in feature
 * space"; this layer adds the musical reading:
 *
 * - repeated_section_with_evolution: an alike pair whose per-dimension
 *   deltas still show a real change ("the second Drop is a repeat, but it
 *   develops"). Evolution = the largest |delta| over the dimensions both
 *   sections have data for (energy, density, activeTrackRatio,
 *   rhythmicActivity) — computed here from features, since
 *   relationships.contrasts covers consecutive pairs only.
 * - repeated_section_low_variation: a "repeat"-kind pair with no meaningful
 *   evolution.
 * - section_reprise: the FIRST and LAST sections of a 3+ section song are
 *   alike (intro/outro bookend). Fires IN ADDITION to the
 *   variation/evolution reading of the same pair — they answer different
 *   questions.
 *
 * A "similar"-kind pair with low evolution produces nothing: the vocabulary
 * stays silent rather than manufacturing a near-repeat.
 *
 * Honesty: confidence is the weakest link of the similarity's own
 * confidence AND the confidences of every dimension that contributed data —
 * a MIDI-only song's evolution reading honestly inherits its thinner
 * evidence.
 */

import { clamp01, normRange, ONSETS_PER_BAR_FULL } from "../features/normalize.js";
import type { MusicalFeatures, SectionFeatures } from "../features/types.js";
import type { MusicalRelationships } from "../relationships/types.js";
import type {
  MusicalObservation,
  ObservationEvidence,
} from "./types.js";

/** Max per-dimension |delta| above which an alike pair reads as evolving. */
export const EVOLUTION_EPS = 0.1;
/** Evolution delta that maps to strength 1.0. */
export const EVOLUTION_FULL = 0.3;

/** min of the defined confidences; undefined when neither carries one. */
function minConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

interface DimDelta {
  metric: string;
  value: number;
  relatedValue: number;
  delta: number;
  confidence?: number;
}

/** Per-dimension b − a over the dimensions BOTH sections have data for
 * (density and activeTrackRatio always qualify). */
function dimDeltas(a: SectionFeatures, b: SectionFeatures): DimDelta[] {
  const dims: DimDelta[] = [];
  const push = (
    metric: string,
    va: number | undefined,
    vb: number | undefined,
    confidence: number | undefined,
  ) => {
    if (va === undefined || vb === undefined) return;
    dims.push({ metric, value: vb, relatedValue: va, delta: vb - va, ...(confidence !== undefined ? { confidence } : {}) });
  };
  push(
    "energy",
    a.energy?.value,
    b.energy?.value,
    minConfidence(a.energy?.confidence, b.energy?.confidence),
  );
  push("density", normRange(a.density, 0, ONSETS_PER_BAR_FULL), normRange(b.density, 0, ONSETS_PER_BAR_FULL), undefined);
  push("activeTrackRatio", a.activeTrackRatio, b.activeTrackRatio, undefined);
  push(
    "rhythmicActivity",
    a.rhythmicActivity?.value,
    b.rhythmicActivity?.value,
    minConfidence(a.rhythmicActivity?.confidence, b.rhythmicActivity?.confidence),
  );
  return dims;
}

export function buildRepetitionObservations(
  features: MusicalFeatures,
  relationships: MusicalRelationships,
): MusicalObservation[] {
  const out: MusicalObservation[] = [];
  const secs = features.sections;
  for (const s of relationships.similarities) {
    if (s.kind === "different") continue;
    // sectionId IS the array index as a string (features/types.ts invariant).
    const a = secs[Number(s.aSectionId)];
    const b = secs[Number(s.bSectionId)];
    const ref = { sectionId: b.sectionId, relatedSectionId: a.sectionId };

    const dims = dimDeltas(a, b);
    const evolution = Math.max(...dims.map((d) => Math.abs(d.delta)));
    let confidence = s.similarity.confidence;
    for (const d of dims) confidence = minConfidence(confidence, d.confidence);
    const evidence: ObservationEvidence[] = dims.map((d) => ({
      metric: `sections[${b.sectionId}].${d.metric}`,
      value: d.value,
      relatedValue: d.relatedValue,
      delta: d.delta,
    }));

    if (evolution > EVOLUTION_EPS) {
      out.push({
        kind: "repeated_section_with_evolution",
        ...ref,
        strength: clamp01(evolution / EVOLUTION_FULL),
        ...(confidence !== undefined ? { confidence } : {}),
        evidence,
      });
    } else if (s.kind === "repeat") {
      out.push({
        kind: "repeated_section_low_variation",
        ...ref,
        strength: s.similarity.value,
        ...(confidence !== undefined ? { confidence } : {}),
        evidence,
      });
    }

    // Reprise: first ↔ last section of a 3+ section song.
    if (
      secs.length >= 3 &&
      s.aSectionId === secs[0].sectionId &&
      s.bSectionId === secs[secs.length - 1].sectionId
    ) {
      out.push({
        kind: "section_reprise",
        ...ref,
        strength: s.similarity.value,
        ...(s.similarity.confidence !== undefined
          ? { confidence: s.similarity.confidence }
          : {}),
        evidence,
      });
    }
  }
  return out;
}
