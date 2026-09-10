/**
 * music/actions/derive.ts — MusicalReasoning → RAW candidate actions.
 *
 * One pass over the observations, in the reasoning layer's fixed emission
 * order: each mapped observation emits its candidate(s) with the target
 * copied off the observation's own ids (ids are canonical; names never
 * enter this layer). No dedupe, no conflict resolution, no ranking here —
 * those are merge.ts / rank.ts, so every stage stays independently
 * testable.
 *
 * Gates are evaluated against the SAME observation set:
 * - requiresAbsent: the gated kind appears nowhere in the set.
 * - requiresCoObservation: the gated kind appears for the SAME section
 *   pair (same sectionId + relatedSectionId).
 *
 * Strength/confidence at this stage are the source observation's own
 * (× the spec's strengthFactor): a single primary trigger preserves the
 * evidence exactly as the reasoning layer measured it.
 */

import { clamp01 } from "../features/normalize.js";
import type { MusicalObservation, MusicalReasoning, ObservationKind } from "../reasoning/types.js";
import { KIND_DIMENSION, OBSERVATION_MAPPINGS } from "./mappings.js";
import type { CreativeAction, CreativeActionTarget } from "./types.js";

/** Pair identity for co-observation gates: the two sections involved,
 * exactly as the observation carries them. */
function pairKey(o: MusicalObservation): string {
  return `${o.sectionId ?? ""}${o.relatedSectionId ?? ""}`;
}

/** Target = spec scope + every id the source observation carries. */
function targetOf(
  o: MusicalObservation,
  scope: NonNullable<CreativeActionTarget["scope"]>,
): CreativeActionTarget {
  return {
    scope,
    ...(o.sectionId !== undefined ? { sectionId: o.sectionId } : {}),
    ...(o.relatedSectionId !== undefined ? { relatedSectionId: o.relatedSectionId } : {}),
    ...(o.trackId !== undefined ? { trackId: o.trackId } : {}),
    ...(o.relatedTrackId !== undefined ? { relatedTrackId: o.relatedTrackId } : {}),
  };
}

export function deriveCandidates(reasoning: MusicalReasoning): CreativeAction[] {
  const observations = reasoning.observations;

  const presentKinds = new Set<ObservationKind>(observations.map((o) => o.kind));
  const pairsByKind = new Map<ObservationKind, Set<string>>();
  for (const o of observations) {
    let set = pairsByKind.get(o.kind);
    if (!set) pairsByKind.set(o.kind, (set = new Set()));
    set.add(pairKey(o));
  }

  const out: CreativeAction[] = [];
  for (const o of observations) {
    const specs = OBSERVATION_MAPPINGS[o.kind];
    if (!specs) continue; // deliberately silent — never fabricated
    for (const spec of specs) {
      if (spec.requiresAbsent !== undefined && presentKinds.has(spec.requiresAbsent)) {
        continue;
      }
      if (
        spec.requiresCoObservation !== undefined &&
        !pairsByKind.get(spec.requiresCoObservation)?.has(pairKey(o))
      ) {
        continue;
      }
      out.push({
        kind: spec.kind,
        target: targetOf(o, spec.scope),
        strength: clamp01(o.strength * (spec.strengthFactor ?? 1)),
        ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
        sourceObservations: [o],
        dimension: KIND_DIMENSION[spec.kind],
      });
    }
  }
  return out;
}
