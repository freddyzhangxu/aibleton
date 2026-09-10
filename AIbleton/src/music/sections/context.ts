/**
 * music/sections/context.ts — target + references → compact planner context.
 *
 * The builder SELECTS from MusicIntelligence (references, not copies; nothing
 * recomputed); the presenter renders the selection under a char budget.
 *
 * Filtering rules (all deterministic):
 *
 *   features     core quartet always: energy / density / activeTrackRatio /
 *                rhythmicActivity. repetition/variation join when a selected
 *                action pushes the variation dimension or a repetition
 *                observation is in scope. The audio/proxy fields (low/mid/
 *                high/impact/tension/release) join when an energy-or-impact
 *                criterion or action is in scope.
 *   observations about the target or a selected reference, ranked
 *                strength × (confidence ?? 1), ties keep emission order;
 *                unrelated observations (Intro↔Outro facts for a Drop goal)
 *                are dropped. Cap 6.
 *   actions      target actions first, then reference actions, then
 *                song-scope actions to fill — the action layer's ranked
 *                order is preserved, never re-invented. Cap 5.
 *   fallback     an unresolved target yields undefined — the caller falls
 *                back to the song-level goal projection (PR13.5), never to
 *                a fabricated section.
 */

import type { MusicGoal } from "../../goal/types.js";
import type { SectionFeatures } from "../features/types.js";
import type { MusicalObservation } from "../reasoning/types.js";
import type { CreativeAction } from "../actions/types.js";
import type { MusicIntelligence } from "../intelligence/types.js";
import { resolveSectionTarget } from "./resolve.js";
import { selectSectionReferences } from "./reference.js";
import type {
  SectionFeatureProjection,
  SectionPlanningContext,
  SectionReference,
  SectionTarget,
} from "./types.js";

export const MAX_SECTION_OBSERVATIONS = 6;
export const MAX_SECTION_ACTIONS = 5;

// ---------------------------------------------------------------------------
// Feature projection — goal-relevance from criteria kinds + action dimensions
// ---------------------------------------------------------------------------

function wantsVariation(goal: MusicGoal, actions: readonly CreativeAction[], observations: readonly MusicalObservation[]): boolean {
  if (actions.some((a) => a.dimension === "variation")) return true;
  return observations.some(
    (o) =>
      o.kind === "section_reprise" ||
      o.kind === "repeated_section_low_variation" ||
      o.kind === "repeated_section_with_evolution",
  );
}

function wantsExtendedEnergy(goal: MusicGoal, actions: readonly CreativeAction[]): boolean {
  if (actions.some((a) => a.dimension === "energy" || a.dimension === "impact")) return true;
  return [...goal.constraints, ...goal.successCriteria].some((c) => c.kind === "section_energy_gt");
}

function projectSectionFeatures(
  s: SectionFeatures,
  goal: MusicGoal,
  actions: readonly CreativeAction[],
  observations: readonly MusicalObservation[],
): SectionFeatureProjection {
  const p: SectionFeatureProjection = {
    density: s.density,
    activeTrackRatio: s.activeTrackRatio,
  };
  if (s.energy) p.energy = s.energy;
  if (s.rhythmicActivity) p.rhythmicActivity = s.rhythmicActivity;
  if (wantsVariation(goal, actions, observations)) {
    if (s.repetition !== undefined) p.repetition = s.repetition;
    if (s.variation !== undefined) p.variation = s.variation;
  }
  if (wantsExtendedEnergy(goal, actions)) {
    if (s.lowEnergy) p.lowEnergy = s.lowEnergy;
    if (s.midEnergy) p.midEnergy = s.midEnergy;
    if (s.highEnergy) p.highEnergy = s.highEnergy;
    if (s.impact) p.impact = s.impact;
    if (s.tension) p.tension = s.tension;
    if (s.release) p.release = s.release;
  }
  return p;
}

/** Share of projection fields that actually carry data (honesty: a projected
 * field whose source was undefined was already omitted — coverage measures
 * what the planner can genuinely read). */
function featureCoverage(p: SectionFeatureProjection): number {
  const total = Object.keys(p).length;
  if (!total) return 0;
  return Object.values(p).filter((v) => v !== undefined).length / total;
}

// ---------------------------------------------------------------------------
// Observation / action filtering — target-centric, reference-aware
// ---------------------------------------------------------------------------

function rankObservations(obs: readonly MusicalObservation[], max: number): MusicalObservation[] {
  return obs
    .map((o, i) => ({ o, i, score: o.strength * (o.confidence ?? 1) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((e) => e.o);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildSectionPlanningContext(
  goal: MusicGoal,
  intel: MusicIntelligence,
): SectionPlanningContext | undefined {
  const resolution = resolveSectionTarget(goal, intel);
  if (!resolution.matched) return undefined;
  const target = resolution.target;

  const references = selectSectionReferences(target, intel, goal);
  const inScope = new Set([target.sectionId, ...references.map((r) => r.sectionId)]);

  const targetFeatures = intel.features.sections.find((s) => s.sectionId === target.sectionId);
  if (!targetFeatures) return undefined; // resolution and features disagree — fail soft

  // Observations: two tiers, target-centric. Facts ABOUT the target rank
  // first (a "second drop" goal must hear "repeated_section_low_variation"
  // even when neighbour transitions score higher); facts that only touch a
  // reference fill what remains. Each tier keeps the score ranking.
  const inScopeObs = intel.reasoning.observations.filter(
    (o) =>
      (o.sectionId !== undefined && inScope.has(o.sectionId)) ||
      (o.relatedSectionId !== undefined && inScope.has(o.relatedSectionId)),
  );
  const aboutTarget = inScopeObs.filter((o) => o.sectionId === target.sectionId);
  const aboutReferences = inScopeObs.filter((o) => o.sectionId !== target.sectionId);
  const observations = [
    ...rankObservations(aboutTarget, MAX_SECTION_OBSERVATIONS),
    ...rankObservations(aboutReferences, MAX_SECTION_OBSERVATIONS),
  ].slice(0, MAX_SECTION_OBSERVATIONS);

  // Actions: the action layer already ranked and capped — we only SELECT.
  // Target first, then references, then song-scope fills the rest; the
  // layer's order is preserved within the whole pass.
  const touchesTarget = (a: CreativeAction) =>
    a.target.sectionId === target.sectionId || a.target.relatedSectionId === target.sectionId;
  const touchesReference = (a: CreativeAction) =>
    (a.target.sectionId !== undefined && inScope.has(a.target.sectionId)) ||
    (a.target.relatedSectionId !== undefined && inScope.has(a.target.relatedSectionId));
  const isSongScope = (a: CreativeAction) =>
    [a.target.sectionId, a.target.relatedSectionId, a.target.trackId, a.target.relatedTrackId].every(
      (id) => id === undefined,
    );
  const targetActions = intel.actions.actions.filter(touchesTarget);
  const referenceActions = intel.actions.actions.filter((a) => !touchesTarget(a) && touchesReference(a));
  const songActions = intel.actions.actions.filter((a) => !touchesTarget(a) && !touchesReference(a) && isSongScope(a));
  const actions = [...targetActions, ...referenceActions, ...songActions].slice(0, MAX_SECTION_ACTIONS);

  const features = projectSectionFeatures(targetFeatures, goal, actions, observations);
  const song = intel.features.song;

  return {
    target,
    references,
    features,
    targetFeatures,
    observations,
    actions,
    song: {
      tempo: song.tempo,
      durationBeats: song.durationBeats,
      sectionCount: song.sectionCount,
    },
    coverage: {
      featureCoverage: featureCoverage(features),
      observationCount: observations.length,
      actionCount: actions.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation — JSON-ready, 2dp, unknown omitted, staged budget cuts
// ---------------------------------------------------------------------------

/** Char budget for the section block (JSON length). */
export const SECTION_CONTEXT_BUDGET = 2200;

const r2 = (x: number): number => Math.round(x * 100) / 100;

function fvOut(f: { value: number; source: string; confidence?: number }): Record<string, unknown> {
  const o: Record<string, unknown> = { v: r2(f.value), s: f.source };
  if (f.confidence !== undefined) o.c = r2(f.confidence);
  return o;
}

function targetOut(t: SectionTarget): Record<string, unknown> {
  return {
    id: t.sectionId,
    name: t.name,
    beats: [r2(t.startBeat), r2(t.endBeat)],
    match: t.match,
    conf: r2(t.confidence),
  };
}

function featuresOut(p: SectionFeatureProjection): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (p.energy) o.energy = fvOut(p.energy);
  if (p.density !== undefined) o.density = r2(p.density);
  if (p.activeTrackRatio !== undefined) o.tracks = r2(p.activeTrackRatio);
  if (p.variation !== undefined) o.var = r2(p.variation);
  if (p.repetition !== undefined) o.rep = r2(p.repetition);
  if (p.rhythmicActivity) o.rhythm = fvOut(p.rhythmicActivity);
  if (p.lowEnergy) o.low = fvOut(p.lowEnergy);
  if (p.midEnergy) o.mid = fvOut(p.midEnergy);
  if (p.highEnergy) o.high = fvOut(p.highEnergy);
  if (p.impact) o.impact = fvOut(p.impact);
  if (p.tension) o.tension = fvOut(p.tension);
  if (p.release) o.release = fvOut(p.release);
  return o;
}

function referenceOut(r: SectionReference): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.sectionId, name: r.name, reason: r.reason, rel: r2(r.relevance) };
  if (r.similarity !== undefined) o.sim = r2(r.similarity);
  if (r.contrast !== undefined) o.contrast = r2(r.contrast);
  return o;
}

function observationOut(o: MusicalObservation): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: o.kind, str: r2(o.strength) };
  if (o.sectionId !== undefined) out.sec = o.sectionId;
  if (o.relatedSectionId !== undefined) out.rel = o.relatedSectionId;
  if (o.confidence !== undefined) out.conf = r2(o.confidence);
  if (o.evidence.length) {
    out.ev = o.evidence.map((e) => {
      let s = e.metric;
      if (e.value !== undefined) s += `=${r2(e.value)}`;
      if (e.relatedValue !== undefined) s += `→${r2(e.relatedValue)}`;
      return s;
    });
  }
  return out;
}

function actionOut(a: CreativeAction): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: a.kind, str: r2(a.strength) };
  const t = a.target;
  if (t.scope !== undefined) out.scope = t.scope;
  if (t.sectionId !== undefined) out.sec = t.sectionId;
  if (t.relatedSectionId !== undefined) out.rel = t.relatedSectionId;
  if (a.confidence !== undefined) out.conf = r2(a.confidence);
  out.src = a.sourceObservations.length;
  return out;
}

/** Cut stages — §55 order: observations → actions → third reference →
 * secondary features → second reference. Target identity and goal-relevant
 * core features are never cut. */
interface CutStage {
  obs: number;
  act: number;
  refs: number;
  extendedFeatures: boolean;
}

const STAGES: CutStage[] = [
  { obs: Number.MAX_SAFE_INTEGER, act: Number.MAX_SAFE_INTEGER, refs: Number.MAX_SAFE_INTEGER, extendedFeatures: true },
  { obs: 4, act: 4, refs: 3, extendedFeatures: true },
  { obs: 3, act: 3, refs: 2, extendedFeatures: true },
  { obs: 3, act: 3, refs: 2, extendedFeatures: false },
  { obs: 2, act: 2, refs: 1, extendedFeatures: false },
  { obs: 1, act: 1, refs: 1, extendedFeatures: false },
];

function render(ctx: SectionPlanningContext, st: CutStage): Record<string, unknown> {
  const features = { ...ctx.features };
  if (!st.extendedFeatures) {
    delete features.lowEnergy;
    delete features.midEnergy;
    delete features.highEnergy;
    delete features.tension;
    delete features.release;
  }
  const out: Record<string, unknown> = {
    target: targetOut(ctx.target),
    features: featuresOut(features),
  };
  if (ctx.references.length) {
    out.references = ctx.references.slice(0, st.refs).map(referenceOut);
  }
  if (ctx.observations.length) {
    out.observations = ctx.observations.slice(0, st.obs).map(observationOut);
  }
  if (ctx.actions.length) {
    out.actions = ctx.actions.slice(0, st.act).map(actionOut);
  }
  out.song = {
    sections: ctx.song.sectionCount,
    ...(ctx.song.tempo !== undefined ? { tempo: ctx.song.tempo } : {}),
  };
  out.coverage = {
    features: r2(ctx.coverage.featureCoverage),
    observations: ctx.coverage.observationCount,
    actions: ctx.coverage.actionCount,
  };
  return out;
}

/**
 * Render the context under the char budget. As with presentGoalContext, the
 * last stage is returned even over budget — a complete structure beats a
 * truncated one.
 */
export function presentSectionPlanningContext(
  ctx: SectionPlanningContext,
  options?: { maxChars?: number },
): Record<string, unknown> {
  const budget = options?.maxChars ?? SECTION_CONTEXT_BUDGET;
  let last: Record<string, unknown> = {};
  for (const st of STAGES) {
    last = render(ctx, st);
    if (JSON.stringify(last).length <= budget) return last;
  }
  return last;
}
