/**
 * music/reference/sections.ts — reference PCM → ReferenceSection[].
 *
 * Pure and deterministic: MonoPcm + precomputed frame curves in, sections
 * out. No I/O, no LLM, no Live.
 *
 * Pipeline (§12):
 *
 *   energy curve → level-shift candidates → merge nearby boundaries
 *                → minimum section length → per-segment features
 *                → role inference
 *
 * Roles are INFERRED, never metadata: every section ships a confidence, and
 * "unknown" is a first-class answer (§13). First-version detection reads
 * energy level shifts only — deliberately modest; a wrong Drop claim is
 * worse than an honest unknown.
 */

import { analyzePcm, FFT_HOP, type AudioFeatures, type MonoPcm } from "../../dsp.js";
import {
  clamp01,
  normLog,
  normRange,
  fv,
  weightedMean,
  BRIGHTNESS_HZ_HI,
  BRIGHTNESS_HZ_LO,
  LOUDNESS_DB_HI,
  LOUDNESS_DB_LO,
  ONSETS_PER_BAR_FULL,
} from "../features/normalize.js";
import type { ReferenceCurves } from "./analyze.js";
import type { ReferenceFeatures, ReferenceSection, ReferenceSectionRole } from "./types.js";

/** Sections shorter than this are merged into a neighbour — a 4-second
 * "section" is a transition, not a musical region. */
export const MIN_SECTION_SEC = 8;

/** Level-shift window (seconds per side) and floor for a real boundary (dB). */
const SHIFT_WINDOW_SEC = 2;
const MIN_SHIFT_DB = 2.5;

// ---------------------------------------------------------------------------
// Segment features — AudioFeatures → ReferenceFeatures (PR11 semantics)
// ---------------------------------------------------------------------------

/**
 * Map dsp.ts segment features onto the reference feature surface. The only
 * tempo-dependent fields (density, rhythmicActivity) stay undefined without
 * a tempo — an honest "no grid", never a fabricated one.
 */
export function featuresFromSegmentAudio(
  audio: AudioFeatures,
  opts: { tempoBpm?: number; coverage?: number },
): ReferenceFeatures {
  const cov = opts.coverage ?? 1;
  const out: ReferenceFeatures = {
    energy: fv(normRange(audio.loudnessDb, LOUDNESS_DB_LO, LOUDNESS_DB_HI), "audio", cov),
    lowEnergy: fv(audio.bands.sub + audio.bands.bass, "audio", cov),
    midEnergy: fv(audio.bands.lowMid + audio.bands.mid, "audio", cov),
    highEnergy: fv(audio.bands.highMid + audio.bands.high, "audio", cov),
    spectralBrightness: fv(
      normLog(audio.spectralCentroidHz, BRIGHTNESS_HZ_LO, BRIGHTNESS_HZ_HI),
      "audio",
      cov,
    ),
  };
  if (audio.transientDensity !== undefined) {
    out.transientDensity = fv(audio.transientDensity, "audio", cov);
  }
  if (audio.dynamicRangeDb !== undefined) {
    out.dynamicRange = fv(audio.dynamicRangeDb, "audio", cov);
  }

  const secPerBar = opts.tempoBpm !== undefined ? 240 / opts.tempoBpm : undefined;
  const onsetsPerBar =
    audio.transientDensity !== undefined && secPerBar !== undefined
      ? audio.transientDensity * secPerBar
      : undefined;
  if (onsetsPerBar !== undefined) {
    out.density = fv(onsetsPerBar, "audio", cov);
    out.rhythmicActivity = fv(normRange(onsetsPerBar, 0, ONSETS_PER_BAR_FULL), "audio", cov);
  }

  // Heuristic proxies — PR11 component weights minus the track-based ones a
  // mixed file cannot see (activeTrackRatio); confidence = input coverage.
  const densityN = onsetsPerBar !== undefined ? normRange(onsetsPerBar, 0, ONSETS_PER_BAR_FULL) : undefined;
  const transientN = densityN; // same onset evidence as PR11's audio fallback
  const impact = weightedMean([
    { v: densityN, w: 0.25 },
    { v: transientN, w: 0.2 },
    { v: out.lowEnergy?.value, w: 0.2 },
    { v: out.highEnergy?.value, w: 0.15 },
  ]);
  if (impact) out.impact = fv(impact.value, "derived", impact.coverage * cov);
  const tension = weightedMean([
    { v: out.highEnergy?.value, w: 0.5 },
    { v: out.rhythmicActivity?.value, w: 0.5 },
  ]);
  if (tension) out.tension = fv(tension.value, "derived", tension.coverage * cov);
  const release = weightedMean([
    { v: densityN !== undefined ? 1 - densityN : undefined, w: 0.4 },
    { v: out.rhythmicActivity !== undefined ? 1 - out.rhythmicActivity.value : undefined, w: 0.3 },
    { v: out.highEnergy !== undefined ? 1 - out.highEnergy.value : undefined, w: 0.3 },
  ]);
  if (release) out.release = fv(release.value, "derived", release.coverage * cov);

  return out;
}

// ---------------------------------------------------------------------------
// Boundary detection — level shifts of the smoothed energy curve
// ---------------------------------------------------------------------------

export interface ReferenceBoundaries {
  /** Frame indices of section starts, ascending; always starts at 0 and the
   * implicit end is the curve length (not included). */
  boundaries: number[];
  /** Shift magnitude (dB) at each boundary after the first — feeds section
   * confidence. Index-aligned with boundaries[1..]. */
  strengths: number[];
}

function smooth(curve: Float64Array, radius: number): Float64Array {
  const n = curve.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    let s = 0;
    for (let j = lo; j < hi; j++) s += curve[j];
    out[i] = s / (hi - lo);
  }
  return out;
}

export function detectReferenceBoundaries(
  curves: ReferenceCurves,
  opts?: { minSectionSec?: number },
): ReferenceBoundaries {
  const e = curves.energyDb;
  const n = e.length;
  if (n === 0) return { boundaries: [0], strengths: [] };

  const smoothRadius = Math.max(1, Math.round(0.5 / curves.hopSec)); // ~0.5 s
  const se = smooth(e, smoothRadius);
  const W = Math.max(1, Math.round(SHIFT_WINDOW_SEC / curves.hopSec));

  // Level shift at i: mean of the next W frames minus the previous W.
  const shift = new Float64Array(n);
  for (let i = W; i + W < n; i++) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < W; j++) {
      a += se[i - W + j];
      b += se[i + 1 + j];
    }
    shift[i] = Math.abs(b / W - a / W);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += shift[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (shift[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);
  const threshold = Math.max(MIN_SHIFT_DB, mean + 0.75 * std);

  // Local maxima above threshold.
  const candidates: { at: number; strength: number }[] = [];
  for (let i = W; i + W < n; i++) {
    if (shift[i] >= threshold && shift[i] >= shift[i - 1] && shift[i] >= shift[i + 1]) {
      candidates.push({ at: i, strength: shift[i] });
    }
  }

  // Merge candidates closer than the minimum section length — keep the
  // stronger, drop the weaker, left-to-right.
  const minGap = Math.max(1, Math.round((opts?.minSectionSec ?? MIN_SECTION_SEC) / curves.hopSec));
  const merged: { at: number; strength: number }[] = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.at - last.at < minGap) {
      if (c.strength > last.strength) merged[merged.length - 1] = c;
    } else {
      merged.push({ ...c });
    }
  }
  return {
    boundaries: [0, ...merged.map((c) => c.at)],
    strengths: merged.map((c) => c.strength),
  };
}

// ---------------------------------------------------------------------------
// Role inference — relative energy shape + position. Inference, not metadata.
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<Exclude<ReferenceSectionRole, "unknown">, string> = {
  intro: "Intro",
  build: "Build",
  drop: "Drop",
  breakdown: "Breakdown",
  verse: "Verse",
  chorus: "Chorus",
  bridge: "Bridge",
  outro: "Outro",
};

interface SegmentDraft {
  startFrame: number;
  endFrame: number;
  edgeStrength: number; // dB shift at the louder edge (0 for file edges)
  features: ReferenceFeatures;
}

function classifyRoles(drafts: SegmentDraft[]): { role: ReferenceSectionRole; margin: number }[] {
  const energies = drafts.map((d) => d.features.energy?.value);
  const known = energies.filter((x): x is number => x !== undefined);
  if (known.length < 2) {
    return drafts.map(() => ({ role: "unknown", margin: 0 }));
  }
  const m = known.reduce((a, b) => a + b, 0) / known.length;
  const sd = Math.sqrt(known.reduce((a, b) => a + (b - m) ** 2, 0) / known.length);

  return drafts.map((d, i) => {
    const e = energies[i];
    if (e === undefined || sd <= 1e-9) return { role: "unknown" as const, margin: 0 };
    const dev = e - m;
    const margin = clamp01(Math.abs(dev) / (2 * sd));
    if (i === 0 && dev < -0.25 * sd) return { role: "intro" as const, margin };
    if (i === drafts.length - 1 && dev < -0.25 * sd) return { role: "outro" as const, margin };
    if (dev >= 0.5 * sd) return { role: "drop" as const, margin };
    if (dev <= -0.5 * sd) return { role: "breakdown" as const, margin };
    const next = energies[i + 1];
    if (next !== undefined && next - e >= 0.12) {
      return { role: "build" as const, margin: clamp01((next - e) / 0.3) };
    }
    return { role: "unknown" as const, margin: 0 };
  });
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Detect reference sections. Always returns at least one section when the
 * PCM has frames — a featureless file simply yields one "unknown" section,
 * never zero (zero would masquerade as "no content").
 */
export function detectReferenceSections(
  pcm: MonoPcm,
  curves: ReferenceCurves,
  opts?: { tempoBpm?: number; minSectionSec?: number },
): ReferenceSection[] {
  const { boundaries, strengths } = detectReferenceBoundaries(curves, opts);
  const n = curves.energyDb.length;
  if (n === 0) return [];
  const beatsPerFrame = ((opts?.tempoBpm ?? 120) / 60) * curves.hopSec; // nominal grid without tempo (see analyze.ts)

  // Enforce minimum section length: merge the shortest segment into the
  // neighbour with the closer mean energy (ties → earlier neighbour).
  const segs = boundaries.map((b, i) => ({
    startFrame: b,
    endFrame: i + 1 < boundaries.length ? boundaries[i + 1] : n,
    strength: i === 0 ? 0 : (strengths[i - 1] ?? 0),
  }));
  const minFrames = Math.max(1, Math.round((opts?.minSectionSec ?? MIN_SECTION_SEC) / curves.hopSec));
  const segEnergy = (s: { startFrame: number; endFrame: number }): number => {
    let sum = 0;
    for (let i = s.startFrame; i < s.endFrame; i++) sum += curves.energyDb[i];
    return sum / Math.max(1, s.endFrame - s.startFrame);
  };
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    const shortIdx = segs.findIndex((s) => s.endFrame - s.startFrame < minFrames);
    if (shortIdx < 0) break;
    const e = segEnergy(segs[shortIdx]);
    const prev = segs[shortIdx - 1];
    const next = segs[shortIdx + 1];
    const mergePrev =
      prev !== undefined &&
      (next === undefined || Math.abs(segEnergy(prev) - e) <= Math.abs(segEnergy(next) - e));
    if (mergePrev && prev) {
      prev.endFrame = segs[shortIdx].endFrame;
      segs.splice(shortIdx, 1);
    } else if (next) {
      next.startFrame = segs[shortIdx].startFrame;
      next.strength = segs[shortIdx].strength;
      segs.splice(shortIdx, 1);
    }
    changed = true;
  }

  // Per-segment features from the PCM slice.
  const drafts: SegmentDraft[] = segs.map((s) => {
    const start = s.startFrame * FFT_HOP;
    const end = Math.min(pcm.samples.length, s.endFrame * FFT_HOP);
    const slice: MonoPcm = {
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      samples: pcm.samples.subarray(start, Math.max(start + 1, end)),
    };
    const audio = analyzePcm(slice);
    return {
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      edgeStrength: s.strength,
      features: featuresFromSegmentAudio(audio, { tempoBpm: opts?.tempoBpm }),
    };
  });

  const roles = classifyRoles(drafts);

  // Labels: role + deterministic ordinal among same-role sections.
  const ordinals = new Map<string, number>();
  return drafts.map((d, i) => {
    const { role, margin } = roles[i];
    let label: string | undefined;
    if (role !== "unknown") {
      const n1 = (ordinals.get(role) ?? 0) + 1;
      ordinals.set(role, n1);
      label = `${ROLE_LABEL[role]} ${n1}`;
    }
    const edge = clamp01(d.edgeStrength / 6); // 6 dB shift = a hard boundary
    const confidence = Math.round(Math.min(0.95, 0.4 + 0.3 * edge + 0.3 * margin) * 100) / 100;
    return {
      id: `reference:section:${i}`,
      ...(label !== undefined ? { label } : {}),
      startBeat: Math.round(d.startFrame * beatsPerFrame * 100) / 100,
      endBeat: Math.round(d.endFrame * beatsPerFrame * 100) / 100,
      role,
      features: d.features,
      confidence,
    } satisfies ReferenceSection;
  });
}
