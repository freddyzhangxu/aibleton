/**
 * dsp.ts — pure audio DSP: WAV/AIFF decode + feature extraction.
 *
 * No I/O, no project imports: Buffer in, numbers out. Decode scope is
 * deliberately narrow — WAV PCM (16/24/32-bit int, 32-bit float) and AIFF
 * PCM (16/24-bit) cover what Live users actually keep in their libraries;
 * everything else returns a structured error instead of throwing.
 *
 * Feature semantics (all dB values are dBFS, floor −100):
 *   rmsDb/peakDb/crestDb — global signal stats; crest = peak − rms is the
 *     "punch" proxy: a squashed, over-limited kick reads < 3 dB.
 *   loudnessDb — K-weighting-INSPIRED mono approximation (RBJ high-shelf +
 *     high-pass, ungated). NOT BS.1770 LUFS — do not quote as LUFS.
 *   dynamicRangeDb — p95 − p10 of short-term (2048/1024) RMS in dB
 *     (LRA-style, EBU R128's loudness-range statistic — p95−p50 reads ~0 on
 *     any half-loud/half-quiet file, so the median is the wrong baseline);
 *     undefined when fewer than 8 frames (short one-shots) so downstream
 *     rules treat it as "no data" rather than 0.
 *   bands — energy FRACTIONS summing to ≈1 over all bins (DC/sub-20Hz bins
 *     count toward the total but toward no band, so DC-heavy files don't
 *     inflate `sub`). Scale-invariant, comparable across files.
 *   spectralCentroidHz — magnitude-weighted mean frequency.
 *   transientDensity — onsets/sec via spectral flux (positive half-wave
 *     magnitude delta, adaptive median threshold, ~70ms refractory);
 *     undefined for clips shorter than 0.5 s.
 *
 * FFT 2048 @ 44.1 kHz = 21.5 Hz/bin, so `sub` (20–60 Hz) is ~2 bins — coarse
 * but sufficient for balance judgments; documented, not silently widened.
 */

import { Buffer } from "node:buffer";

// ---------------------------------------------------------------- types ----

export const AUDIO_BAND_NAMES = ["sub", "bass", "lowMid", "mid", "highMid", "high"] as const;
export type AudioBandName = (typeof AUDIO_BAND_NAMES)[number];
export type AudioBands = Record<AudioBandName, number>;

export interface AudioFeatures {
  durationSec: number;
  sampleRate: number;
  channels: number;
  rmsDb: number;
  peakDb: number;
  crestDb: number;
  /** K-weighting-inspired mono approx, ungated — NOT BS.1770 LUFS. */
  loudnessDb: number;
  /** p95 − p10 of short-term RMS (dB), LRA-style; undefined when < 8 frames. */
  dynamicRangeDb?: number;
  spectralCentroidHz: number;
  bands: AudioBands;
  /** Onsets/sec from spectral flux; undefined when duration < 0.5 s. */
  transientDensity?: number;
  /** Analysis was truncated by maxSeconds. */
  partial?: true;
}

export interface MonoPcm {
  sampleRate: number;
  channels: number;
  samples: Float32Array; // mono mix, −1..1
}

export type DecodeOutcome =
  /** totalFrames = declared length BEFORE maxSeconds truncation (coverage). */
  | { pcm: MonoPcm; truncated: boolean; totalFrames?: number }
  | { error: string };

const DB_FLOOR = 1e-5; // −100 dBFS
const toDb = (x: number): number => 20 * Math.log10(Math.max(x, DB_FLOOR));

/** Exported for music/reference (frame-curve analysis over the same grid) —
 * decode scope and feature semantics above are unchanged. */
export const FFT_N = 2048;
export const FFT_HOP = 1024;

/** [lo, hi) edges in Hz; `high` runs to Nyquist. */
const BAND_EDGES: [number, number][] = [
  [20, 60],
  [60, 120],
  [120, 500],
  [500, 2000],
  [2000, 6000],
  [6000, Infinity],
];

// ---------------------------------------------------------------- decode ---

/** Dispatch on the file extension; unsupported formats return an error, never throw. */
export function decodeAudioBuffer(
  fileName: string,
  buf: Buffer,
  opts?: { maxSeconds?: number },
): DecodeOutcome {
  const ext = (/\.([^.]+)$/.exec(fileName)?.[1] ?? "").toLowerCase();
  if (ext === "wav") return decodeWav(buf, opts);
  if (ext === "aif" || ext === "aiff") return decodeAiff(buf, opts);
  if (["mp3", "flac", "ogg", "m4a"].includes(ext)) {
    return { error: `unsupported format ".${ext}" (WAV/AIFF only)` };
  }
  return { error: `unknown audio extension ".${ext}" (WAV/AIFF only)` };
}

/** decode + analyze in one call; sets partial when truncated. */
export function featuresFromBuffer(
  fileName: string,
  buf: Buffer,
  opts?: { maxSeconds?: number },
): { features: AudioFeatures } | { error: string } {
  const dec = decodeAudioBuffer(fileName, buf, opts);
  if ("error" in dec) return { error: dec.error };
  const features = analyzePcm(dec.pcm);
  if (dec.truncated) features.partial = true;
  return { features };
}

interface FmtInfo {
  format: number; // 1 = PCM int, 3 = IEEE float
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export function decodeWav(buf: Buffer, opts?: { maxSeconds?: number }): DecodeOutcome {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { error: "not a RIFF/WAVE file" };
  }
  let fmt: FmtInfo | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && body + 26 <= buf.length) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format tag sits at body offset 24.
        format = buf.readUInt16LE(body + 24);
      }
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
    }
    if (fmt && dataOff >= 0) break;
    off = body + size + (size & 1); // chunks are pad-byte aligned
  }
  if (!fmt) return { error: "WAV missing fmt chunk" };
  if (dataOff < 0) return { error: "WAV missing data chunk" };
  const { format, channels, sampleRate, bitsPerSample } = fmt;
  if (channels < 1 || channels > 8) return { error: `unsupported channel count ${channels}` };
  if (sampleRate < 8000 || sampleRate > 192000) return { error: `implausible sample rate ${sampleRate}` };
  if (!(format === 1 || format === 3)) return { error: "unsupported WAV encoding (not PCM/float)" };

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = channels * bytesPerSample;
  if (![2, 3, 4].includes(bytesPerSample) || frameBytes <= 0) {
    return { error: `unsupported WAV bit depth ${bitsPerSample}` };
  }
  if (format === 3 && bitsPerSample !== 32) return { error: "unsupported float WAV depth" };

  const declaredFrames = Math.floor(dataLen / frameBytes);
  let frames = declaredFrames;
  let truncated = false;
  const maxFrames = opts?.maxSeconds !== undefined ? Math.floor(opts.maxSeconds * sampleRate) : frames;
  if (frames > maxFrames) {
    frames = maxFrames;
    truncated = true;
  }
  if (frames <= 0) return { error: "WAV data chunk is empty" };

  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = dataOff + f * frameBytes;
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = base + c * bytesPerSample;
      let v: number;
      if (format === 3) {
        v = buf.readFloatLE(o);
        if (!Number.isFinite(v)) v = 0; // a corrupt float must not poison every sum
      } else if (bytesPerSample === 2) {
        v = buf.readInt16LE(o) / 32768;
      } else if (bytesPerSample === 3) {
        let x = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else {
        v = buf.readInt32LE(o) / 2147483648;
      }
      acc += v;
    }
    samples[f] = acc / channels; // hard-panned sources read ~3 dB low — acceptable
  }
  return { pcm: { sampleRate, channels, samples }, truncated, totalFrames: declaredFrames };
}

/** 80-bit IEEE-754 extended float (AIFF sample rate). */
function readExtended80(buf: Buffer, off: number): number {
  const se = buf.readUInt16BE(off);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  const mant = buf.readUInt32BE(off + 2) * 2 ** 32 + buf.readUInt32BE(off + 6);
  // The integer bit is explicit in the mantissa — exponent offset is 63, not 52.
  return sign * mant * 2 ** (exp - 16383 - 63);
}

export function decodeAiff(buf: Buffer, opts?: { maxSeconds?: number }): DecodeOutcome {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "FORM") return { error: "not a FORM/AIFF file" };
  const formType = buf.toString("ascii", 8, 12);
  if (formType !== "AIFF" && formType !== "AIFC") return { error: "not an AIFF/AIFC file" };

  let channels = 0;
  let numFrames = 0;
  let bitDepth = 0;
  let sampleRate = 0;
  let dataOff = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === "COMM" && body + 18 <= buf.length) {
      channels = buf.readInt16BE(body);
      numFrames = buf.readUInt32BE(body + 2);
      bitDepth = buf.readInt16BE(body + 6);
      sampleRate = Math.round(readExtended80(buf, body + 8));
      if (formType === "AIFC") {
        const compression = buf.toString("ascii", body + 18, body + 22);
        if (compression !== "NONE") {
          return { error: `unsupported AIFC compression "${compression}" (PCM only)` };
        }
      }
    } else if (id === "SSND" && body + 8 <= buf.length) {
      const offset = buf.readUInt32BE(body);
      dataOff = body + 8 + offset;
      dataLen = Math.max(0, Math.min(size - 8 - offset, buf.length - dataOff));
    }
    if (sampleRate && dataOff >= 0) break;
    off = body + size + (size & 1);
  }
  if (!sampleRate) return { error: "AIFF missing COMM chunk" };
  if (dataOff < 0) return { error: "AIFF missing SSND chunk" };
  if (channels < 1 || channels > 8) return { error: `unsupported channel count ${channels}` };
  if (sampleRate < 8000 || sampleRate > 192000) return { error: `implausible sample rate ${sampleRate}` };
  if (bitDepth !== 16 && bitDepth !== 24) return { error: `unsupported AIFF bit depth ${bitDepth}` };

  const bytesPerSample = bitDepth / 8;
  const frameBytes = channels * bytesPerSample;
  const declaredFrames = Math.min(numFrames, Math.floor(dataLen / frameBytes));
  let frames = declaredFrames;
  let truncated = false;
  const maxFrames = opts?.maxSeconds !== undefined ? Math.floor(opts.maxSeconds * sampleRate) : frames;
  if (frames > maxFrames) {
    frames = maxFrames;
    truncated = true;
  }
  if (frames <= 0) return { error: "AIFF sound data is empty" };

  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = dataOff + f * frameBytes;
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = base + c * bytesPerSample;
      let v: number;
      if (bytesPerSample === 2) {
        v = buf.readInt16BE(o) / 32768;
      } else {
        let x = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      }
      acc += v;
    }
    samples[f] = acc / channels;
  }
  return { pcm: { sampleRate, channels, samples }, truncated, totalFrames: declaredFrames };
}

// ---------------------------------------------------------------- FFT ------

const hannCache = new Map<number, Float64Array>();
export function hannWindow(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/** In-place iterative radix-2 Cooley-Tukey. Length must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < half; k++) {
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cwr - xi * cwi;
        const vi = xr * cwi + xi * cwr;
        re[i + k + half] = re[i + k] - vr;
        im[i + k + half] = im[i + k] - vi;
        re[i + k] += vr;
        im[i + k] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** bin index → band index (0-5), −1 for DC / sub-20Hz / above-Nyquist. Cached per sample rate. */
const bandMapCache = new Map<number, Int8Array>();
function bandMapFor(sampleRate: number): Int8Array {
  let map = bandMapCache.get(sampleRate);
  if (map) return map;
  const bins = FFT_N / 2 + 1;
  map = new Int8Array(bins).fill(-1);
  const hzPerBin = sampleRate / FFT_N;
  for (let k = 1; k < bins; k++) {
    const f = k * hzPerBin;
    for (let b = 0; b < BAND_EDGES.length; b++) {
      if (f >= BAND_EDGES[b][0] && f < BAND_EDGES[b][1]) {
        map[k] = b;
        break;
      }
    }
  }
  bandMapCache.set(sampleRate, map);
  return map;
}

// ------------------------------------------------------------- loudness ----

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ high-shelf, Q form (K-weighting pre-filter constants). */
function highShelf(fc: number, gainDb: number, q: number, fs: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sq = 2 * Math.sqrt(A) * alpha;
  const b0 = A * (A + 1 + (A - 1) * cosw + sq);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosw);
  const b2 = A * (A + 1 + (A - 1) * cosw - sq);
  const a0 = A + 1 - (A - 1) * cosw + sq;
  const a1 = 2 * (A - 1 - (A + 1) * cosw);
  const a2 = A + 1 - (A - 1) * cosw - sq;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ high-pass (K-weighting RLB filter constants). */
function highPass(fc: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: (-(1 + cosw)) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquadInPlace(x: Float64Array, f: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

// -------------------------------------------------------------- analyze ----

export function analyzePcm(pcm: MonoPcm): AudioFeatures {
  const { sampleRate, channels, samples } = pcm;
  const n = samples.length;
  const durationSec = n / sampleRate;

  // Global pass.
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const rmsDb = toDb(rms);
  const peakDb = toDb(peak);
  const crestDb = peakDb - rmsDb;

  // Short-term RMS (unwindowed) → dynamic range.
  const stDb: number[] = [];
  for (let start = 0; start + FFT_N <= n; start += FFT_HOP) {
    let s = 0;
    for (let i = start; i < start + FFT_N; i++) s += samples[i] * samples[i];
    stDb.push(toDb(Math.sqrt(s / FFT_N)));
  }
  let dynamicRangeDb: number | undefined;
  if (stDb.length >= 8) {
    const sorted = [...stDb].sort((a, b) => a - b);
    const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))];
    dynamicRangeDb = pick(0.95) - pick(0.1);
  }

  // Loudness: K-inspired weighting on a Float64 copy.
  const weighted = new Float64Array(n);
  for (let i = 0; i < n; i++) weighted[i] = samples[i];
  applyBiquadInPlace(weighted, highShelf(1681.9744509555319, 3.99984385397, 0.7071752369554193, sampleRate));
  applyBiquadInPlace(weighted, highPass(38.13547087613982, 0.5003270373253953, sampleRate));
  let wSumSq = 0;
  for (let i = 0; i < n; i++) wSumSq += weighted[i] * weighted[i];
  const loudnessDb = -0.691 + 10 * Math.log10(Math.max(wSumSq / Math.max(1, n), 1e-10));

  // STFT: band power, spectral centroid, spectral flux.
  const win = hannWindow(FFT_N);
  const bandMap = bandMapFor(sampleRate);
  const bins = FFT_N / 2 + 1;
  const bandSums = [0, 0, 0, 0, 0, 0]; // Float64 accumulators — f32 drifts over ~7k frames
  let totalPower = 0;
  let centroidNum = 0;
  let centroidDen = 0;
  const flux = new Float64Array(Math.max(0, Math.floor((n - FFT_N) / FFT_HOP) + 1));
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const prevMag = new Float64Array(bins);
  const hzPerBin = sampleRate / FFT_N;

  let frameCount = 0;
  for (let start = 0; start + FFT_N <= n; start += FFT_HOP, frameCount++) {
    for (let i = 0; i < FFT_N; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const power = mag * mag;
      totalPower += power;
      const b = bandMap[k];
      if (b >= 0) bandSums[b] += power;
      centroidNum += k * hzPerBin * mag;
      centroidDen += mag;
      const d = mag - prevMag[k];
      if (d > 0) flux[frameCount] += d;
      prevMag[k] = mag;
    }
  }

  const bands: AudioBands = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
  if (totalPower > 1e-12) {
    for (let b = 0; b < 6; b++) bands[AUDIO_BAND_NAMES[b]] = bandSums[b] / totalPower;
  }
  const spectralCentroidHz = centroidDen > 1e-12 ? centroidNum / centroidDen : 0;

  // Onsets from flux: adaptive median threshold × 1.5, peak-pick with refractory.
  let transientDensity: number | undefined;
  if (durationSec >= 0.5 && flux.length > 1) {
    const W = 16;
    const refractory = 3; // ~70 ms at hop 1024
    let onsets = 0;
    let last = -refractory;
    for (let i = 1; i < flux.length - 1; i++) {
      const lo = Math.max(0, i - W);
      const hi = Math.min(flux.length, i + W + 1);
      const windowVals = [...flux.subarray(lo, hi)].sort((a, b) => a - b);
      const median = windowVals[Math.floor(windowVals.length / 2)];
      const threshold = median * 1.5 + 1e-9;
      if (
        flux[i] > threshold &&
        flux[i] >= flux[i - 1] &&
        flux[i] >= flux[i + 1] &&
        i - last >= refractory
      ) {
        onsets++;
        last = i;
      }
    }
    transientDensity = onsets / durationSec;
  }

  return {
    durationSec,
    sampleRate,
    channels,
    rmsDb,
    peakDb,
    crestDb,
    loudnessDb,
    ...(dynamicRangeDb !== undefined ? { dynamicRangeDb } : {}),
    spectralCentroidHz,
    bands,
    ...(transientDensity !== undefined ? { transientDensity } : {}),
  };
}
