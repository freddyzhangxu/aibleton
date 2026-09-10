/**
 * music/intelligence/present.ts — render a GoalMusicContext for the set_goal
 * tool result: one JSON-ready object, small enough for a weak relay model to
 * actually read.
 *
 * Discipline (the analysis/present.ts philosophy, shrunk):
 * - Numbers round to 2 decimals — the planner compares magnitudes, it does
 *   not need float noise.
 * - FeatureValue flattens to {v, s, c?} (value / source / confidence).
 *   undefined fields are OMITTED — honesty rule 1 survives serialization:
 *   a missing key reads "no data", never zero.
 * - Observations carry their evidence as one-line strings
 *   ("sections[3].energy=0.71→0.74") — machine-traversable metric paths
 *   stay intact, deltas are recomputable.
 * - A char budget with staged cuts: observations 8→5→3, similarities drop,
 *   track rows collapse, section rows collapse, last observation standing.
 *   Cutting never fabricates and never truncates mid-structure — the worst
 *   case is the smallest complete rendering.
 */

import type { FeatureValue, SectionFeatures, SongFeatures, TrackFeatures } from "../features/types.js";
import type { ArrangementArc, SectionContrast, SectionSimilarity } from "../relationships/types.js";
import type { MusicalObservation } from "../reasoning/types.js";
import type { GoalMusicContext } from "./types.js";

/** Char budget for the whole music block (JSON length). */
export const CONTEXT_BUDGET = 1500;

const r2 = (x: number): number => Math.round(x * 100) / 100;

function fvOut(f: FeatureValue): Record<string, unknown> {
  const o: Record<string, unknown> = { v: r2(f.value), s: f.source };
  if (f.confidence !== undefined) o.c = r2(f.confidence);
  return o;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function sectionRow(s: SectionFeatures, collapse: boolean): Record<string, unknown> {
  if (collapse) {
    const o: Record<string, unknown> = {
      id: s.sectionId,
      name: s.name,
      density: r2(s.density),
      tracks: r2(s.activeTrackRatio),
    };
    if (s.energy) o.energy = fvOut(s.energy);
    return o;
  }
  const o: Record<string, unknown> = {
    id: s.sectionId,
    name: s.name,
    bars: s.bars,
    density: r2(s.density),
    tracks: r2(s.activeTrackRatio),
  };
  if (s.repetition !== undefined) o.rep = r2(s.repetition);
  if (s.variation !== undefined) o.var = r2(s.variation);
  if (s.rhythmicActivity) o.rhythm = fvOut(s.rhythmicActivity);
  if (s.energy) o.energy = fvOut(s.energy);
  if (s.lowEnergy) o.low = fvOut(s.lowEnergy);
  if (s.midEnergy) o.mid = fvOut(s.midEnergy);
  if (s.highEnergy) o.high = fvOut(s.highEnergy);
  if (s.impact) o.impact = fvOut(s.impact);
  if (s.tension) o.tension = fvOut(s.tension);
  if (s.release) o.release = fvOut(s.release);
  return o;
}

function trackRow(t: TrackFeatures, collapse: boolean): Record<string, unknown> {
  if (collapse) {
    const o: Record<string, unknown> = { id: t.trackId, name: t.name, active: r2(t.activeRatio) };
    if (t.role) o.role = t.role;
    if (t.muted) o.muted = true;
    return o;
  }
  const o: Record<string, unknown> = { id: t.trackId, name: t.name, active: r2(t.activeRatio) };
  if (t.role) o.role = t.role;
  if (t.muted) o.muted = true;
  if (t.density !== undefined) o.density = r2(t.density);
  if (t.pitchRange !== undefined) o.pitchRange = r2(t.pitchRange);
  if (t.repetition !== undefined) o.rep = r2(t.repetition);
  if (t.rhythmicActivity) o.rhythm = fvOut(t.rhythmicActivity);
  if (t.lowEnergy) o.low = fvOut(t.lowEnergy);
  if (t.midEnergy) o.mid = fvOut(t.midEnergy);
  if (t.highEnergy) o.high = fvOut(t.highEnergy);
  return o;
}

function songOut(s: SongFeatures): Record<string, unknown> {
  const o: Record<string, unknown> = {
    bars: s.bars,
    tracks: s.trackCount,
    tempo: s.tempo,
    sections: s.sectionCount,
  };
  if (s.avgDensity !== undefined) o.avgDensity = r2(s.avgDensity);
  if (s.avgActiveTrackRatio !== undefined) o.avgTracks = r2(s.avgActiveTrackRatio);
  if (s.minEnergy !== undefined) o.minE = r2(s.minEnergy);
  if (s.maxEnergy !== undefined) o.maxE = r2(s.maxEnergy);
  if (s.energyRange !== undefined) o.rangeE = r2(s.energyRange);
  return o;
}

function arcOut(a: ArrangementArc): Record<string, unknown> {
  const o: Record<string, unknown> = {
    cov: r2(a.energyCoverage),
    curve: a.energyCurve.map((v) => (v === undefined ? null : r2(v))),
  };
  if (a.kind) o.kind = a.kind;
  if (a.peakSectionId !== undefined) o.peak = a.peakSectionId;
  if (a.peakPosition !== undefined) o.peakPos = r2(a.peakPosition);
  return o;
}

function contrastOut(c: SectionContrast): Record<string, unknown> {
  const o: Record<string, unknown> = {
    from: c.fromSectionId,
    to: c.toSectionId,
    kind: c.kind,
    dDens: r2(c.densityDelta),
    dTrk: r2(c.activeTrackRatioDelta),
  };
  if (c.energyDelta) o.dE = fvOut(c.energyDelta);
  return o;
}

function similarityOut(s: SectionSimilarity): Record<string, unknown> {
  return { a: s.aSectionId, b: s.bSectionId, kind: s.kind, sim: fvOut(s.similarity) };
}

function evidenceLine(e: MusicalObservation["evidence"][number]): string {
  let s = e.metric;
  if (e.value !== undefined) s += `=${r2(e.value)}`;
  if (e.relatedValue !== undefined) s += `→${r2(e.relatedValue)}`;
  return s;
}

function observationOut(o: MusicalObservation): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: o.kind, str: r2(o.strength) };
  if (o.sectionId !== undefined) out.sec = o.sectionId;
  if (o.relatedSectionId !== undefined) out.rel = o.relatedSectionId;
  if (o.trackId !== undefined) out.trk = o.trackId;
  if (o.relatedTrackId !== undefined) out.rtrk = o.relatedTrackId;
  if (o.confidence !== undefined) out.conf = r2(o.confidence);
  if (o.evidence.length) out.ev = o.evidence.map(evidenceLine);
  return out;
}

// ---------------------------------------------------------------------------
// Budgeted render — staged cuts, each still a complete structure
// ---------------------------------------------------------------------------

interface CutStage {
  obs: number; // observation cap for this stage
  sims: boolean; // keep similarities
  collTracks: boolean;
  collSections: boolean;
}

const STAGES: CutStage[] = [
  { obs: Number.MAX_SAFE_INTEGER, sims: true, collTracks: false, collSections: false },
  { obs: 5, sims: true, collTracks: false, collSections: false },
  { obs: 3, sims: true, collTracks: false, collSections: false },
  { obs: 3, sims: false, collTracks: false, collSections: false },
  { obs: 3, sims: false, collTracks: true, collSections: false },
  { obs: 3, sims: false, collTracks: true, collSections: true },
  { obs: 1, sims: false, collTracks: true, collSections: true },
];

function render(ctx: GoalMusicContext, st: CutStage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    scope: ctx.scope,
    song: songOut(ctx.song),
    arc: arcOut(ctx.arc),
    coverage: ctx.coverage,
    observations: ctx.observations.slice(0, st.obs).map(observationOut),
  };
  if (ctx.target.track || ctx.target.section) out.target = ctx.target;
  if (ctx.sections.length) {
    out.sections = ctx.sections.map((s) => sectionRow(s, st.collSections));
  }
  if (ctx.tracks.length) out.tracks = ctx.tracks.map((t) => trackRow(t, st.collTracks));
  if (ctx.contrasts.length) out.contrasts = ctx.contrasts.map(contrastOut);
  if (st.sims && ctx.similarities.length) out.similarities = ctx.similarities.map(similarityOut);
  if (ctx.unmatched.length) out.unmatched = ctx.unmatched;
  return out;
}

/**
 * Render ctx under the char budget. The last stage is returned even when it
 * still exceeds the budget (pathologically long names) — a complete
 * structure over the limit beats a truncated one.
 */
export function presentGoalContext(
  ctx: GoalMusicContext,
  budget: number = CONTEXT_BUDGET,
): Record<string, unknown> {
  let last: Record<string, unknown> = {};
  for (const st of STAGES) {
    last = render(ctx, st);
    if (JSON.stringify(last).length <= budget) return last;
  }
  return last;
}
