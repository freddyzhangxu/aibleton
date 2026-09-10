/**
 * PR15 test fixtures: a literal 7-section MusicIntelligence (full control
 * over features/relationships/observations/actions — the sections layer only
 * READS that container, so a literal is the honest unit-fixture), plus the
 * goal literal helper. Integration tests use the REAL chain (repeatIntel
 * from the intelligence fixtures) instead.
 */

import type { MusicGoal } from "../../../goal/types.js";
import type { FeatureValue, SectionFeatures } from "../../features/types.js";
import type {
  ArrangementArc,
  SectionContrast,
  SectionSimilarity,
} from "../../relationships/types.js";
import type { MusicalObservation } from "../../reasoning/types.js";
import type { CreativeAction } from "../../actions/types.js";
import type { MusicIntelligence } from "../../intelligence/types.js";

export function goalOf(over: Partial<MusicGoal> = {}): MusicGoal {
  return {
    type: over.type ?? "edit",
    ...(over.target ? { target: over.target } : {}),
    objective: over.objective ?? "test goal",
    constraints: over.constraints ?? [],
    successCriteria: over.successCriteria ?? [],
  };
}

const fv = (value: number, confidence = 0.9): FeatureValue => ({ value, source: "derived", confidence });

let secBeat = 0;
function sec(
  id: string,
  name: string,
  over: Partial<SectionFeatures> = {},
): SectionFeatures {
  const startBeat = over.startBeat ?? secBeat;
  const endBeat = over.endBeat ?? startBeat + 32;
  secBeat = endBeat;
  return {
    sectionId: id,
    name,
    startBeat,
    endBeat,
    bars: (endBeat - startBeat) / 4,
    density: 2,
    activeTrackRatio: 0.5,
    ...over,
  };
}

export interface FixtureSpec {
  /** energy per section id; undefined = energy unknown. */
  energy?: Record<string, number | undefined>;
  variation?: Record<string, number | undefined>;
  repetition?: Record<string, number | undefined>;
  similarities?: SectionSimilarity[];
  observations?: MusicalObservation[];
  actions?: CreativeAction[];
}

/**
 * Intro / Build 1 / Drop 1 / Breakdown / Build 2 / Drop 2 / Outro — the
 * canonical PR15 arrangement. Deterministic: identical on every call.
 */
export function sevenSectionIntel(spec: FixtureSpec = {}): MusicIntelligence {
  secBeat = 0;
  const defs: Array<[string, string, number, number]> = [
    // id, name, default energy, default density
    ["0", "Intro", 0.2, 0.5],
    ["1", "Build 1", 0.5, 2],
    ["2", "Drop 1", 0.8, 4],
    ["3", "Breakdown", 0.3, 1],
    ["4", "Build 2", 0.55, 2.2],
    ["5", "Drop 2", 0.78, 4],
    ["6", "Outro", 0.25, 0.8],
  ];
  const sections: SectionFeatures[] = defs.map(([id, name, energy, density]) => {
    const e = spec.energy && id in spec.energy ? spec.energy[id] : energy;
    const s = sec(id, name, {
      density,
      activeTrackRatio: 0.6,
      ...(e !== undefined ? { energy: fv(e) } : {}),
      rhythmicActivity: fv(0.5),
    });
    const variation = spec.variation?.[id];
    if (variation !== undefined) s.variation = variation;
    const repetition = spec.repetition?.[id];
    if (repetition !== undefined) s.repetition = repetition;
    return s;
  });

  const contrasts: SectionContrast[] = sections.slice(1).map((to, i) => {
    const from = sections[i];
    const dE =
      from.energy && to.energy
        ? fv(to.energy.value - from.energy.value, Math.min(from.energy.confidence ?? 1, to.energy.confidence ?? 1))
        : undefined;
    return {
      fromSectionId: from.sectionId,
      toSectionId: to.sectionId,
      ...(dE ? { energyDelta: dE } : {}),
      densityDelta: to.density - from.density,
      activeTrackRatioDelta: 0,
      kind: "rise",
      basis: "energy",
    };
  });

  const similarities: SectionSimilarity[] = spec.similarities ?? [
    {
      aSectionId: "2",
      bSectionId: "5",
      similarity: fv(0.91, 0.85),
      kind: "repeat",
    },
    {
      aSectionId: "1",
      bSectionId: "4",
      similarity: fv(0.75, 0.85),
      kind: "similar",
    },
  ];

  const arc: ArrangementArc = {
    energyCurve: sections.map((s) => s.energy?.value),
    energyCoverage: sections.filter((s) => s.energy).length / sections.length,
    kind: "arch",
    peakSectionId: "2",
    peakPosition: 0.4,
  };

  const observations: MusicalObservation[] = spec.observations ?? [
    {
      kind: "section_reprise",
      sectionId: "5",
      relatedSectionId: "2",
      strength: 0.8,
      confidence: 0.85,
      evidence: [{ metric: "sections[5].variation", value: 0.18, relatedValue: 0.3 }],
    },
    {
      kind: "repeated_section_low_variation",
      sectionId: "5",
      relatedSectionId: "2",
      strength: 0.7,
      evidence: [],
    },
    {
      kind: "weak_contrast",
      sectionId: "5",
      relatedSectionId: "4",
      strength: 0.5,
      evidence: [],
    },
    {
      // About the Intro only — unrelated to a Drop 2 target + its references.
      kind: "energy_increase",
      sectionId: "0",
      strength: 0.9,
      evidence: [],
    },
  ];

  const actions: CreativeAction[] = spec.actions ?? [
    {
      kind: "introduce_variation",
      target: { sectionId: "5", relatedSectionId: "2", scope: "section" },
      strength: 0.8,
      confidence: 0.85,
      dimension: "variation",
      sourceObservations: [observations[0]],
    },
    {
      kind: "develop_section",
      target: { sectionId: "5", relatedSectionId: "2", scope: "section" },
      strength: 0.7,
      dimension: "variation",
      sourceObservations: [observations[1]],
    },
    {
      kind: "increase_section_contrast",
      target: { sectionId: "5", relatedSectionId: "4", scope: "transition" },
      strength: 0.6,
      dimension: "contrast",
      sourceObservations: [observations[2]],
    },
    {
      kind: "increase_energy",
      target: { scope: "song" },
      strength: 0.4,
      dimension: "energy",
      sourceObservations: [observations[3]],
    },
    {
      // Track-scoped, touches no section in scope — must be filtered out.
      kind: "remove_layer",
      target: { trackId: "9", scope: "track" },
      strength: 0.9,
      dimension: "layering",
      sourceObservations: [observations[3]],
    },
  ];

  return {
    features: {
      song: {
        durationBeats: secBeat,
        bars: secBeat / 4,
        trackCount: 4,
        midiTrackCount: 4,
        audioTrackCount: 0,
        tempo: 128,
        sectionCount: sections.length,
      },
      sections,
      tracks: [],
    },
    relationships: { contrasts, similarities, arc },
    reasoning: {
      observations,
      coverage: { sections: sections.length, analyzedSections: sections.length },
    },
    actions: {
      actions,
      coverage: { sourceObservations: observations.length, actionableObservations: observations.length },
    },
  };
}
