/**
 * music/reference/actions.ts — ReferenceGap → CreativeAction (PR14 vocabulary).
 *
 * Pure and deterministic. The mapping is deliberately CONSERVATIVE (§26): a
 * reference is a target example, not musical truth — only semantically
 * unambiguous, meaningful gaps become candidates, and only through the
 * existing action vocabulary (no "match_reference" verbs, ever).
 *
 * Mapped (both directions where the vocabulary has an opposite):
 *
 *   energy ↑/↓            → increase_energy / decrease_energy
 *   density ↑/↓           → increase_density / decrease_density
 *   active_track_ratio ↑/↓→ increase_layering / decrease_layering
 *   rhythmic_activity ↑/↓ → increase_rhythmic_activity / decrease_rhythmic_activity
 *   impact ↑/↓            → increase_impact / reduce_impact
 *   variation ↑           → introduce_variation
 *   section_contrast ↑    → increase_section_contrast
 *
 * Never mapped (§28 — "reference differs" must not read as "current is
 * wrong" on mix/mastering-sensitive axes): spectral_brightness,
 * dynamic_range, low/mid/high_energy, tension, release, repetition. Those
 * gaps stay available to the planner as EVIDENCE only.
 */

import type { CreativeAction, CreativeActionKind, CreativeDimension } from "../actions/types.js";
import type { MusicalObservation } from "../reasoning/types.js";
import type { ReferenceGap, ReferenceGapMetric } from "./types.js";

/** Reference actions are planner hints — never more than this (§36). */
export const MAX_REFERENCE_ACTIONS = 5;

/** Gaps weaker than this confidence (when one is present) stay evidence —
 * a low-trust comparison must not become an intervention candidate. */
export const MIN_ACTION_CONFIDENCE = 0.5;

interface Mapping {
  up: CreativeActionKind;
  down?: CreativeActionKind;
  dimension: CreativeDimension;
}

const GAP_ACTION_MAP: Partial<Record<ReferenceGapMetric, Mapping>> = {
  energy: { up: "increase_energy", down: "decrease_energy", dimension: "energy" },
  density: { up: "increase_density", down: "decrease_density", dimension: "density" },
  active_track_ratio: { up: "increase_layering", down: "decrease_layering", dimension: "layering" },
  rhythmic_activity: {
    up: "increase_rhythmic_activity",
    down: "decrease_rhythmic_activity",
    dimension: "rhythm",
  },
  impact: { up: "increase_impact", down: "reduce_impact", dimension: "impact" },
  variation: { up: "introduce_variation", dimension: "variation" },
  section_contrast: { up: "increase_section_contrast", dimension: "contrast" },
};

/** Tie-break order for equal strength/confidence — deterministic, mirrors
 * the mapping table's declaration order (specific musical axes first). */
const METRIC_RANK: ReferenceGapMetric[] = [
  "energy",
  "density",
  "rhythmic_activity",
  "active_track_ratio",
  "impact",
  "variation",
  "section_contrast",
];

/** The gap as a reasoning-layer observation — the provenance chain every
 * CreativeAction must carry (sourceObservations is never empty). */
function gapObservation(gap: ReferenceGap): MusicalObservation {
  return {
    kind: "reference_gap",
    ...(gap.currentSectionId !== undefined ? { sectionId: gap.currentSectionId } : {}),
    ...(gap.referenceSectionId !== undefined ? { relatedSectionId: gap.referenceSectionId } : {}),
    strength: gap.strength,
    ...(gap.confidence !== undefined ? { confidence: gap.confidence } : {}),
    evidence: [
      {
        metric: `reference.${gap.metric}`,
        ...(gap.current !== undefined ? { value: gap.current.value } : {}),
        ...(gap.reference !== undefined ? { relatedValue: gap.reference.value } : {}),
        // reasoning-layer convention: value − relatedValue (current − reference).
        ...(gap.delta !== undefined ? { delta: -gap.delta } : {}),
      },
    ],
  };
}

/**
 * Derive conservative action candidates from gaps. "similar"/"unknown" gaps
 * and unmapped metrics produce nothing; one action per metric at most;
 * ranked strength > confidence > metric rank, capped at MAX_REFERENCE_ACTIONS.
 */
export function deriveReferenceActions(gaps: readonly ReferenceGap[]): CreativeAction[] {
  const out: { action: CreativeAction; metric: ReferenceGapMetric; order: number }[] = [];
  for (const gap of gaps) {
    if (gap.direction !== "higher_in_reference" && gap.direction !== "lower_in_reference") continue;
    const map = GAP_ACTION_MAP[gap.metric];
    if (!map) continue;
    const kind = gap.direction === "higher_in_reference" ? map.up : map.down;
    if (!kind) continue;
    if (gap.confidence !== undefined && gap.confidence < MIN_ACTION_CONFIDENCE) continue;

    out.push({
      metric: gap.metric,
      order: out.length,
      action: {
        kind,
        target: {
          ...(gap.currentSectionId !== undefined ? { sectionId: gap.currentSectionId } : {}),
          ...(gap.referenceSectionId !== undefined ? { relatedSectionId: gap.referenceSectionId } : {}),
          scope: "section",
        },
        strength: gap.strength,
        ...(gap.confidence !== undefined ? { confidence: gap.confidence } : {}),
        sourceObservations: [gapObservation(gap)],
        dimension: map.dimension,
      },
    });
  }

  return out
    .sort(
      (x, y) =>
        y.action.strength - x.action.strength ||
        (y.action.confidence ?? 0) - (x.action.confidence ?? 0) ||
        METRIC_RANK.indexOf(x.metric) - METRIC_RANK.indexOf(y.metric) ||
        x.order - y.order,
    )
    // Duplicate kinds (hand-built gap lists can carry one metric twice): the
    // strongest candidate speaks, the rest is redundant noise.
    .filter((e, i, arr) => arr.findIndex((o) => o.action.kind === e.action.kind) === i)
    .slice(0, MAX_REFERENCE_ACTIONS)
    .map((e) => e.action);
}
