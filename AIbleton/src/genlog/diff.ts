/**
 * genlog/diff.ts — iteration N-1 ↔ iteration N: what changed.
 *
 * Pure and deterministic, following the reference-gap precedent
 * (music/reference/gap.ts) turned longitudinal: a diff entry exists only
 * when BOTH records carry the metric (§24-style honesty — missing is
 * unknown, never delta vs zero). Deltas are neutral (after − before);
 * whether a delta is an IMPROVEMENT is a goal-layer judgement (PR18), not
 * something the diff presumes.
 */

import type { GenerationRecord } from "./types.js";
import { AUDIO_BAND_NAMES, type AudioFeatures } from "../dsp.js";

export const GENERATION_DIFF_METRICS = [
  "rmsDb",
  "peakDb",
  "crestDb",
  "loudnessDb",
  "dynamicRangeDb",
  "spectralCentroidHz",
  "transientDensity",
  ...AUDIO_BAND_NAMES.map((b) => `band_${b}` as const),
] as const;

export type GenerationDiffMetric = (typeof GENERATION_DIFF_METRICS)[number];

export interface DiffEntry {
  before: number;
  after: number;
  /** after − before; sign is neutral, improvement is the caller's call. */
  delta: number;
}

export interface GenerationDiff {
  /** Record ids: from (earlier) → to (later). */
  from: string;
  to: string;
  /** Only metrics present on BOTH sides. Empty when either side lacks features. */
  metrics: Partial<Record<GenerationDiffMetric, DiffEntry>>;
}

function read(f: AudioFeatures, m: GenerationDiffMetric): number | undefined {
  if (m.startsWith("band_")) return f.bands[m.slice(5) as (typeof AUDIO_BAND_NAMES)[number]];
  return f[m as Exclude<GenerationDiffMetric, `band_${string}`>];
}

export function diffGenerations(from: GenerationRecord, to: GenerationRecord): GenerationDiff {
  const metrics: GenerationDiff["metrics"] = {};
  const a = from.features;
  const b = to.features;
  if (a && b) {
    for (const m of GENERATION_DIFF_METRICS) {
      const before = read(a, m);
      const after = read(b, m);
      if (before === undefined || after === undefined) continue;
      metrics[m] = { before, after, delta: after - before };
    }
  }
  return { from: from.id, to: to.id, metrics };
}
