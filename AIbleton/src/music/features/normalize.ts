/**
 * music/features/normalize.ts — units → comparable ranges.
 *
 * Every quantity that crosses a feature boundary as "comparable" lands in
 * 0-1 through one of these helpers; raw physical units (dB, Hz, semitones,
 * onsets/sec) stay raw on the fields that document them. The anchors below
 * are heuristic calibration points, not standards — they exist so that "0.5"
 * means roughly the same thing across features. Change them deliberately,
 * never incidentally.
 */

import type { FeatureSource, FeatureValue } from "./types.js";

// ---------------------------------------------------------------------------
// Anchors (documented heuristics)
// ---------------------------------------------------------------------------

/** Onsets/bar that maps to rhythmicActivity 1.0 — 16th-note coverage in 4/4. */
export const ONSETS_PER_BAR_FULL = 16;

/** Source-file loudness anchors for energyAudio (dBFS): −45 ≈ quiet program
 * material, −8 ≈ loud modern master. */
export const LOUDNESS_DB_LO = -45;
export const LOUDNESS_DB_HI = -8;

/** Spectral centroid anchors for spectralBrightness (Hz, log-scaled):
 * 200 Hz ≈ dark, 8 kHz ≈ bright. */
export const BRIGHTNESS_HZ_LO = 200;
export const BRIGHTNESS_HZ_HI = 8000;

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** (x − lo) / (hi − lo), clamped to 0-1. Degenerate ranges (hi <= lo) read 0. */
export function normRange(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0;
  return clamp01((x - lo) / (hi - lo));
}

/** normRange that propagates "no data" instead of inventing a number. */
export function normOpt(x: number | undefined, lo: number, hi: number): number | undefined {
  return x === undefined ? undefined : normRange(x, lo, hi);
}

/** Log2-scaled normRange for frequency-like quantities (centroid Hz).
 * Non-positive x clamps to the bottom of the range. */
export function normLog(x: number, lo: number, hi: number): number {
  return normRange(Math.log2(Math.max(x, 1e-9)), Math.log2(lo), Math.log2(hi));
}

// ---------------------------------------------------------------------------
// FeatureValue construction / combination
// ---------------------------------------------------------------------------

export function fv(value: number, source: FeatureSource, confidence?: number): FeatureValue {
  return confidence === undefined ? { value, source } : { value, source, confidence };
}

export interface WeightedComponent {
  /** undefined = this input had no data; the weight is dropped and the
   * coverage (→ confidence) shrinks accordingly. */
  v?: number;
  w: number;
}

/**
 * Weighted mean over the components that have data.
 * Returns undefined when NO component has data (never invents a 0).
 * coverage = present weight ÷ total declared weight — the honest answer to
 * "how much of this proxy's evidence was actually there".
 */
export function weightedMean(
  components: WeightedComponent[],
): { value: number; coverage: number } | undefined {
  let sum = 0;
  let wPresent = 0;
  let wTotal = 0;
  for (const c of components) {
    wTotal += c.w;
    if (c.v !== undefined) {
      sum += c.v * c.w;
      wPresent += c.w;
    }
  }
  if (wPresent <= 0 || wTotal <= 0) return undefined;
  return { value: sum / wPresent, coverage: wPresent / wTotal };
}
