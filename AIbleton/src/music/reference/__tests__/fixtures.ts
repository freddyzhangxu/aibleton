/**
 * PR16 test fixtures: deterministic WAV/PCM synthesis for the analysis layer
 * (seeded LCG noise — no Math.random), plus literal ReferenceSection /
 * ReferenceAnalysis / SectionFeatures builders for the pure layers (align /
 * gap / actions / present only READ those containers, so literals are the
 * honest unit fixtures — same idiom as the PR15 fixtures).
 */

import { Buffer } from "node:buffer";
import type { FeatureValue, SectionFeatures } from "../../features/types.js";
import type { MonoPcm } from "../../../dsp.js";
import type { ReferenceAnalysis, ReferenceFeatures, ReferenceSection, ReferenceSectionRole } from "../types.js";

// ---------------------------------------------------------------------------
// Deterministic audio synthesis
// ---------------------------------------------------------------------------

/** Seeded LCG noise in −1..1 — deterministic across runs and machines. */
export function noise(len: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (((s / 0xffffffff) * 2 - 1) * amp);
  }
  return out;
}

/** Concatenate (amplitude, seconds) noise segments into one mono PCM. */
export function pcmOfSegments(segments: [amp: number, seconds: number][], sampleRate = 44100): MonoPcm {
  const total = segments.reduce((n, [, sec]) => n + Math.round(sec * sampleRate), 0);
  const samples = new Float32Array(total);
  let off = 0;
  let seed = 7;
  for (const [amp, sec] of segments) {
    const len = Math.round(sec * sampleRate);
    samples.set(noise(len, amp, seed), off);
    off += len;
    seed += 13;
  }
  return { sampleRate, channels: 1, samples };
}

/** Click track at a fixed BPM: short bursts every beat — strong periodicity
 * for the tempo estimator. */
export function clickTrack(bpm: number, seconds: number, sampleRate = 44100): MonoPcm {
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  const beat = Math.round((60 / bpm) * sampleRate);
  const clickLen = Math.round(0.01 * sampleRate);
  const burst = noise(clickLen, 0.8, 3);
  for (let at = 0; at + clickLen < n; at += beat) {
    samples.set(burst, at);
  }
  return { sampleRate, channels: 1, samples };
}

/** 16-bit PCM WAV container around mono samples (dsp.ts's decode scope). */
export function wavOf(pcm: MonoPcm): Buffer {
  const { sampleRate, samples } = pcm;
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM int
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Literal feature builders (pure-layer fixtures)
// ---------------------------------------------------------------------------

export const fv = (value: number, confidence = 0.9): FeatureValue => ({
  value,
  source: "audio",
  confidence,
});

/** Current-side section literal (the fields the gap layer reads). */
export function curSection(id: string, name: string, over: Partial<SectionFeatures> = {}): SectionFeatures {
  return {
    sectionId: id,
    name,
    startBeat: 0,
    endBeat: 32,
    bars: 8,
    density: 2,
    activeTrackRatio: 0.5,
    ...over,
  };
}

export function refSection(
  index: number,
  over: {
    role?: ReferenceSectionRole;
    label?: string;
    startBeat?: number;
    endBeat?: number;
    confidence?: number;
    features?: ReferenceFeatures;
  } = {},
): ReferenceSection {
  return {
    id: `reference:section:${index}`,
    ...(over.label !== undefined ? { label: over.label } : {}),
    startBeat: over.startBeat ?? 0,
    endBeat: over.endBeat ?? 32,
    role: over.role ?? "unknown",
    features: over.features ?? {},
    confidence: over.confidence ?? 0.8,
  };
}

export function refAnalysis(sections: ReferenceSection[], over: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis {
  return {
    source: { type: "audio_file", path: "/tmp/reference.wav" },
    durationSeconds: 120,
    features: {},
    sections,
    coverage: { duration: 1, analyzedBeats: 1, featureCoverage: 1, sectionCoverage: 1 },
    ...over,
  };
}
