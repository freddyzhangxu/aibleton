/**
 * music/relationships/arc.ts — the song-level energy curve and its shape.
 *
 * energyCurve is a straight projection of sections[].energy?.value —
 * undefined entries are sections whose energy is unknown (honesty rule 1),
 * and energyCoverage says how much of the curve the classification stands
 * on. Classification runs over the defined subsequence (order preserved),
 * so a gap bridges silently in the deltas but shows up in the coverage.
 *
 * Shapes: flat / build / breakdown / arch / valley / irregular. Ties at the
 * peak/trough resolve to the EARLIEST section, so a rise to a sustained
 * plateau classifies by that earliest maximum. "irregular" is the honest
 * "none of the named shapes", not a failure.
 */

import type { MusicalFeatures } from "../features/types.js";
import type { ArcKind, ArrangementArc } from "./types.js";

/** max−min energy below which the curve reads "flat". Heuristic anchor. */
export const ARC_FLAT_RANGE = 0.2;
/** Consecutive delta beyond which a step counts as a rise/fall. Heuristic anchor. */
export const ARC_STEP_EPS = 0.05;

function classifyArc(values: number[]): ArcKind | undefined {
  if (values.length < 2) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < ARC_FLAT_RANGE) return "flat";

  const deltas: number[] = [];
  for (let i = 0; i + 1 < values.length; i++) deltas.push(values[i + 1] - values[i]);
  const rises = deltas.filter((d) => d > ARC_STEP_EPS).length;
  const falls = deltas.filter((d) => d < -ARC_STEP_EPS).length;
  const peakIdx = values.indexOf(max); // earliest on tie
  const troughIdx = values.indexOf(min);
  const interior = (idx: number) => idx > 0 && idx < values.length - 1;
  const before = (idx: number) => deltas.slice(0, idx);
  const after = (idx: number) => deltas.slice(idx);
  const noFalls = (ds: number[]) => ds.every((d) => d > -ARC_STEP_EPS);
  const noRises = (ds: number[]) => ds.every((d) => d < ARC_STEP_EPS);

  if (falls === 0 && rises > 0 && peakIdx === values.length - 1) return "build";
  if (rises === 0 && falls > 0 && troughIdx === values.length - 1) return "breakdown";
  if (interior(peakIdx) && noFalls(before(peakIdx)) && noRises(after(peakIdx))) return "arch";
  if (interior(troughIdx) && noRises(before(troughIdx)) && noFalls(after(troughIdx))) {
    return "valley";
  }
  return "irregular";
}

export function buildArrangementArc(features: MusicalFeatures): ArrangementArc {
  const sections = features.sections;
  const energyCurve = sections.map((s) => s.energy?.value);
  const valued: { i: number; v: number }[] = [];
  energyCurve.forEach((v, i) => {
    if (v !== undefined) valued.push({ i, v });
  });
  const energyCoverage = sections.length > 0 ? valued.length / sections.length : 0;
  if (valued.length === 0) return { energyCurve, energyCoverage };

  const peak = valued.reduce((best, x) => (x.v > best.v ? x : best)); // earliest on tie
  const peakSection = sections[peak.i];
  const kind = classifyArc(valued.map((x) => x.v));
  const durationBeats = features.song.durationBeats;

  return {
    energyCurve,
    energyCoverage,
    ...(kind !== undefined ? { kind } : {}),
    peakSectionId: peakSection.sectionId,
    ...(durationBeats > 0
      ? { peakPosition: (peakSection.startBeat + peakSection.endBeat) / 2 / durationBeats }
      : {}),
  };
}
