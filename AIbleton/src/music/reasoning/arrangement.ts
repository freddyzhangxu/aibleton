/**
 * music/reasoning/arrangement.ts — song-level arrangement observations.
 *
 * Reads relationships.arc (the classified energy curve) plus the section
 * energies it was built from. The arc's shape kinds project directly:
 * "build" → clear_build, "breakdown" → clear_breakdown, "flat" →
 * weak_contrast. On top of that, four facts the arc kind alone doesn't
 * state: strong_contrast (absolute energy range), breakdown_after_peak /
 * energy_recovery (the post-peak dip and what follows it),
 * limited_energy_cycle (peaked and never came down), repeated_peak
 * (the maximum is reached more than once).
 *
 * breakdown_after_peak and limited_energy_cycle are exact complements:
 * when there is at least one post-peak section with known energy, precisely
 * one of the two fires.
 *
 * Honesty: every observation here stands on the energy curve, so confidence
 * = arc.energyCoverage — a shape read from 2 of 6 sections says so. Songs
 * with no known energies produce no arrangement observations at all.
 */

import { clamp01 } from "../features/normalize.js";
import type { MusicalFeatures } from "../features/types.js";
import { ARC_FLAT_RANGE } from "../relationships/arc.js";
import type { MusicalRelationships } from "../relationships/types.js";
import type { MusicalObservation } from "./types.js";

/** song.energyRange at/above which the arrangement reads strong_contrast. */
export const STRONG_CONTRAST_RANGE = 0.4;
/** Post-peak energy drop that counts as a real dip (breakdown/recovery).
 * Deliberately larger than the arc's step eps: a cycle is about sections,
 * not steps. Heuristic anchor. */
export const ENERGY_CYCLE_FALL = 0.15;
/** Energy within this of the maximum counts as "at peak" (repeat detection). */
export const PEAK_EPS = 0.05;

interface Valued {
  i: number;
  v: number;
}

export function buildArrangementObservations(
  features: MusicalFeatures,
  relationships: MusicalRelationships,
): MusicalObservation[] {
  const out: MusicalObservation[] = [];
  const { arc } = relationships;
  const secs = features.sections;
  const range = features.song.energyRange;
  const confidence = arc.energyCoverage;

  const valued: Valued[] = [];
  secs.forEach((s, i) => {
    if (s.energy !== undefined) valued.push({ i, v: s.energy.value });
  });
  if (valued.length === 0) return out;

  // --- shape projections -------------------------------------------------
  if (arc.kind === "build" || arc.kind === "breakdown" || arc.kind === "flat") {
    const peak = valued.reduce((best, x) => (x.v > best.v ? x : best)); // earliest on tie
    const trough = valued.reduce((best, x) => (x.v < best.v ? x : best));
    if (arc.kind === "flat") {
      // strength = "how flat": 1 at zero range, → 0 at the arc's flat ceiling.
      out.push({
        kind: "weak_contrast",
        strength: 1 - clamp01((range ?? 0) / ARC_FLAT_RANGE),
        confidence,
        evidence: [{ metric: "song.energyRange", value: range }],
      });
    } else {
      const anchor = arc.kind === "build" ? peak : trough;
      out.push({
        kind: arc.kind === "build" ? "clear_build" : "clear_breakdown",
        sectionId: secs[anchor.i].sectionId,
        strength: clamp01((range ?? 0) / STRONG_CONTRAST_RANGE),
        confidence,
        evidence: [
          { metric: "song.energyRange", value: range },
          { metric: `sections[${anchor.i}].energy`, value: anchor.v },
        ],
      });
    }
  }

  // --- absolute contrast ---------------------------------------------------
  if (range !== undefined && range >= STRONG_CONTRAST_RANGE) {
    out.push({
      kind: "strong_contrast",
      strength: clamp01(range / (2 * STRONG_CONTRAST_RANGE)),
      confidence,
      evidence: [{ metric: "song.energyRange", value: range }],
    });
  }

  // --- peak family ---------------------------------------------------------
  // Gated on prominence: the peak must stand ENERGY_CYCLE_FALL above the
  // song's floor, otherwise a flat arrangement would read "limited cycle"
  // and "repeated peak" — noise on top of weak_contrast, not facts.
  const peak = valued.reduce((best, x) => (x.v > best.v ? x : best)); // earliest on tie
  const trough = valued.reduce((best, x) => (x.v < best.v ? x : best));
  const peakId = secs[peak.i].sectionId;
  const after = valued.filter((x) => x.i > peak.i);
  if (peak.v - trough.v >= ENERGY_CYCLE_FALL && after.length > 0) {
    const minAfter = after.reduce((best, x) => (x.v < best.v ? x : best)); // earliest on tie
    const dip = peak.v - minAfter.v;
    if (dip >= ENERGY_CYCLE_FALL) {
      out.push({
        kind: "breakdown_after_peak",
        sectionId: secs[minAfter.i].sectionId,
        relatedSectionId: peakId,
        strength: clamp01(dip / (2 * ENERGY_CYCLE_FALL)),
        confidence,
        evidence: [
          {
            metric: `sections[${minAfter.i}].energy`,
            value: minAfter.v,
            relatedValue: peak.v,
            delta: -dip,
          },
        ],
      });
      // Recovery: a later section climbs back out of the trough.
      const rec = valued.find((x) => x.i > minAfter.i && x.v - minAfter.v >= ENERGY_CYCLE_FALL);
      if (rec !== undefined) {
        out.push({
          kind: "energy_recovery",
          sectionId: secs[rec.i].sectionId,
          relatedSectionId: secs[minAfter.i].sectionId,
          strength: clamp01((rec.v - minAfter.v) / (2 * ENERGY_CYCLE_FALL)),
          confidence,
          evidence: [
            {
              metric: `sections[${rec.i}].energy`,
              value: rec.v,
              relatedValue: minAfter.v,
              delta: rec.v - minAfter.v,
            },
          ],
        });
      }
    } else {
      // Peaked and never came down — strength = how little it ever dipped.
      out.push({
        kind: "limited_energy_cycle",
        sectionId: peakId,
        relatedSectionId: secs[minAfter.i].sectionId,
        strength: 1 - clamp01(dip / ENERGY_CYCLE_FALL),
        confidence,
        evidence: [
          {
            metric: `sections[${minAfter.i}].energy`,
            value: minAfter.v,
            relatedValue: peak.v,
            delta: -dip,
          },
        ],
      });
    }
  }

  // Repeated peak: the maximum is reached by more than one section (same
  // prominence gate as the rest of the peak family).
  const atPeak =
    peak.v - trough.v >= ENERGY_CYCLE_FALL
      ? valued.filter((x) => peak.v - x.v <= PEAK_EPS)
      : [];
  if (atPeak.length >= 2) {
    out.push({
      kind: "repeated_peak",
      sectionId: peakId,
      relatedSectionId: secs[atPeak[1].i].sectionId,
      strength: clamp01((atPeak.length - 1) / 2), // 2 peaks → 0.5, 3+ → 1.0
      confidence,
      evidence: [
        {
          metric: `sections[${atPeak[1].i}].energy`,
          value: atPeak[1].v,
          relatedValue: peak.v,
          delta: atPeak[1].v - peak.v,
        },
      ],
    });
  }

  return out;
}
