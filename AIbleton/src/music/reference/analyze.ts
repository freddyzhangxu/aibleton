/**
 * music/reference/analyze.ts — reference audio input → ReferenceAnalysis.
 *
 * The ONLY module in this layer that touches audio input — and even here the
 * boundary is a Buffer (file I/O lives in the extension layer: paths.ts /
 * audiofiles.ts). Everything is pure and deterministic: same bytes + same
 * options → identical analysis.
 *
 * Pipeline:
 *
 *   Buffer → decodeAudioBuffer (dsp.ts) → MonoPcm
 *          → whole-file AudioFeatures (dsp.ts analyzePcm)
 *          → frame curves (short-term energy + spectral flux)
 *          → tempo estimate (flux autocorrelation)
 *          → detectReferenceSections (sections.ts)
 *          → ReferenceAnalysis + coverage
 *
 * Tempo honesty: the estimate ships as a FeatureValue with the autocorrelation
 * prominence as confidence, or stays undefined when too weak to trust. Without
 * a tempo, beat-axis fields (durationBeats, density, rhythmicActivity) are
 * undefined and section boundaries ride the documented nominal 120 BPM grid.
 */

import type { Buffer } from "node:buffer";
import {
  analyzePcm,
  decodeAudioBuffer,
  fftInPlace,
  hannWindow,
  FFT_N,
  FFT_HOP,
  type AudioFeatures,
  type MonoPcm,
} from "../../dsp.js";
import { normRange, LOUDNESS_DB_LO, LOUDNESS_DB_HI, fv } from "../features/normalize.js";
import { detectReferenceSections, featuresFromSegmentAudio } from "./sections.js";
import type {
  ReferenceAnalysis,
  ReferenceCoverage,
  ReferenceError,
  ReferenceSource,
} from "./types.js";

/** Analyzer version — part of the cache identity (§46). Bump when the
 * analysis semantics change, never incidentally. */
export const REFERENCE_ANALYZER_VERSION = "1";

/** Default analysis cap: a full track is rarely longer; longer files are
 * analyzed for their first N seconds and marked partial. */
export const REFERENCE_MAX_SECONDS = 8 * 60;

/** Nominal grid for the beat axis when no tempo is known (1 beat = 0.5 s).
 * Documented in types.ts — a coordinate system, never a tempo claim. */
export const NOMINAL_BPM = 120;

// ---------------------------------------------------------------------------
// Frame curves — short-term energy + spectral flux over the dsp.ts grid
// ---------------------------------------------------------------------------

export interface ReferenceCurves {
  /** Short-term RMS in dBFS per frame. */
  energyDb: Float64Array;
  /** Spectral flux (positive half-wave magnitude delta) per frame. */
  flux: Float64Array;
  hopSec: number;
}

export function computeReferenceCurves(pcm: MonoPcm): ReferenceCurves {
  const { sampleRate, samples } = pcm;
  const n = samples.length;
  const frames = Math.max(0, Math.floor((n - FFT_N) / FFT_HOP) + 1);
  const energyDb = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const win = hannWindow(FFT_N);
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const bins = FFT_N / 2 + 1;
  const prevMag = new Float64Array(bins);

  for (let f = 0, start = 0; start + FFT_N <= n; f++, start += FFT_HOP) {
    let s = 0;
    for (let i = 0; i < FFT_N; i++) {
      const x = samples[start + i];
      s += x * x;
      re[i] = x * win[i];
      im[i] = 0;
    }
    energyDb[f] = 20 * Math.log10(Math.max(Math.sqrt(s / FFT_N), 1e-5));
    fftInPlace(re, im);
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const d = mag - prevMag[k];
      if (d > 0) flux[f] += d;
      prevMag[k] = mag;
    }
  }
  return { energyDb, flux, hopSec: FFT_HOP / sampleRate };
}

// ---------------------------------------------------------------------------
// Tempo — autocorrelation of the onset envelope over 70–180 BPM, with a
// subharmonic check (half-tempo peaks are the classic failure mode).
// ---------------------------------------------------------------------------

const TEMPO_MIN_BPM = 70;
const TEMPO_MAX_BPM = 180;

export interface TempoEstimate {
  bpm: number;
  /** 0-1: peak prominence of the winning lag — honest trust, not a claim. */
  confidence: number;
}

export function estimateTempo(flux: Float64Array, hopSec: number): TempoEstimate | undefined {
  const n = flux.length;
  if (n < 32) return undefined; // ~0.75 s at 44.1 kHz — too short to say anything
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  if (mean <= 1e-9) return undefined; // no onsets at all — no tempo evidence

  // Mean-subtracted envelope.
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = flux[i] - mean;

  const lagFor = (bpm: number): number => 60 / (bpm * hopSec);
  const minLag = Math.max(2, Math.floor(lagFor(TEMPO_MAX_BPM)));
  const maxLag = Math.min(Math.floor(n / 2), Math.ceil(lagFor(TEMPO_MIN_BPM)));
  if (maxLag <= minLag) return undefined;

  const ac = (lag: number): number => {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    return s / (n - lag);
  };

  // Score rewards harmonic reinforcement: a true beat period correlates at
  // its multiples too; a spurious lag generally doesn't.
  const scores = new Float64Array(maxLag + 1);
  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = ac(lag);
    if (2 * lag <= maxLag) score += 0.5 * ac(2 * lag);
    if (3 * lag <= maxLag) score += 0.25 * ac(3 * lag);
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestScore <= 0) return undefined;

  // Prominence: the winner against the noise floor — mean |score| over lags
  // NOT adjacent to it. A sparse click track anti-correlates almost
  // everywhere, so a plain mean is the wrong baseline (it reads ≤ 0).
  let floorSum = 0;
  let floorCount = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) <= 3) continue;
    floorSum += Math.abs(scores[lag]);
    floorCount++;
  }
  if (!floorCount || floorSum <= 0) return undefined;
  const prominence = bestScore / (floorSum / floorCount);
  if (prominence < 4) return undefined; // a beat grid stands ~10× over the floor; noise ~3×

  const bpm = 60 / (bestLag * hopSec);
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.min(1, (prominence - 4) / 8) };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type ReferenceAnalysisOutcome =
  | { analysis: ReferenceAnalysis }
  | { error: ReferenceError; message?: string };

/** Whole-file ReferenceFeatures via the shared segment mapper (coverage 1 —
 * the whole analyzed span produced them). */
function wholeFileFeatures(audio: AudioFeatures, tempoBpm?: number) {
  return featuresFromSegmentAudio(audio, { tempoBpm, coverage: 1 });
}

/**
 * Decode + analyze a reference audio buffer. Never throws: every failure is
 * a structured ReferenceError so the agent flow degrades to plain
 * MusicIntelligence (§62).
 */
export function analyzeReferenceBuffer(
  source: ReferenceSource,
  buf: Buffer,
  opts?: { maxSeconds?: number; tempoBpm?: number },
): ReferenceAnalysisOutcome {
  if (source.type !== "audio_file") {
    // Reserved source type (§6): the runtime cannot reliably obtain rendered
    // track audio — say so instead of pretending.
    return { error: "reference_unavailable", message: "live_audio sources are not supported" };
  }
  const dec = decodeAudioBuffer(source.path, buf, { maxSeconds: opts?.maxSeconds ?? REFERENCE_MAX_SECONDS });
  if ("error" in dec) return { error: "reference_analysis_failed", message: dec.error };

  const { pcm, truncated } = dec;
  const totalFrames = dec.totalFrames ?? pcm.samples.length;
  if (pcm.samples.length < FFT_N) return { error: "reference_empty", message: "audio too short to analyze" };

  const audio = analyzePcm(pcm);
  if (truncated) audio.partial = true;
  // Digital silence decodes fine but carries no musical evidence.
  if (audio.peakDb <= -90) return { error: "reference_empty", message: "audio is silent" };

  const curves = computeReferenceCurves(pcm);
  const estimated = opts?.tempoBpm === undefined ? estimateTempo(curves.flux, curves.hopSec) : undefined;
  const tempoBpm = opts?.tempoBpm ?? estimated?.bpm;
  const tempoConfidence = opts?.tempoBpm !== undefined ? 1 : estimated?.confidence;

  const sections = detectReferenceSections(pcm, curves, { tempoBpm });
  const durationSeconds = audio.durationSec;
  const beatsPerSecond = (tempoBpm ?? NOMINAL_BPM) / 60;

  const features = wholeFileFeatures(audio, tempoBpm);
  const declaredFields = Object.keys(features).length;
  const presentFields = Object.values(features).filter((v) => v !== undefined).length;

  const coverage: ReferenceCoverage = {
    duration: totalFrames > 0 ? Math.min(1, pcm.samples.length / totalFrames) : 0,
    analyzedBeats: curves.energyDb.length > 0 ? 1 : 0,
    featureCoverage: declaredFields > 0 ? presentFields / declaredFields : 0,
    sectionCoverage:
      sections.length > 0 && durationSeconds > 0
        ? Math.min(
            1,
            sections.reduce((s, x) => s + (x.endBeat - x.startBeat), 0) / (durationSeconds * beatsPerSecond),
          )
        : 0,
  };

  const analysis: ReferenceAnalysis = {
    source,
    ...(tempoBpm !== undefined ? { durationBeats: durationSeconds * (tempoBpm / 60) } : {}),
    durationSeconds,
    ...(tempoBpm !== undefined
      ? { tempo: fv(tempoBpm, "audio", tempoConfidence) }
      : {}),
    energy: fv(normRange(audio.loudnessDb, LOUDNESS_DB_LO, LOUDNESS_DB_HI), "audio", 1),
    features,
    sections,
    coverage,
    ...(truncated ? { partial: true as const } : {}),
  };
  return { analysis };
}
