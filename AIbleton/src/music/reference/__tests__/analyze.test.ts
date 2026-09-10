/**
 * analyze.test.ts — the audio-input boundary: decode → curves → tempo →
 * sections → ReferenceAnalysis. Determinism, coverage, and honest unknowns.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { analyzeReferenceBuffer, estimateTempo, computeReferenceCurves } from "../analyze.js";
import { clickTrack, noise, pcmOfSegments, wavOf } from "./fixtures.js";
import type { ReferenceSource } from "../types.js";

const SRC: ReferenceSource = { type: "audio_file", path: "/tmp/ref.wav" };

test("deterministic: same buffer → byte-identical analysis", () => {
  const buf = wavOf(pcmOfSegments([[0.02, 8], [0.5, 8], [0.02, 8]]));
  const a = analyzeReferenceBuffer(SRC, buf);
  const b = analyzeReferenceBuffer(SRC, buf);
  assert.deepEqual(a, b);
});

test("energy contrast: a loud segment reads more energetic than a quiet one", () => {
  const buf = wavOf(pcmOfSegments([[0.01, 9], [0.6, 9]]));
  const out = analyzeReferenceBuffer(SRC, buf);
  assert.ok("analysis" in out);
  assert.equal(out.analysis.sections.length, 2);
  const [quiet, loud] = out.analysis.sections;
  assert.ok(quiet.features.energy !== undefined && loud.features.energy !== undefined);
  assert.ok(loud.features.energy!.value > quiet.features.energy!.value + 0.2);
  // Role inference: loud second half of a two-part file is the "drop".
  assert.equal(loud.role, "drop");
  assert.equal(loud.label, "Drop 1");
});

test("tempo: a 120 BPM click track estimates ~120 and yields beat-axis fields", () => {
  const pcm = clickTrack(120, 12);
  const est = estimateTempo(computeReferenceCurves(pcm).flux, computeReferenceCurves(pcm).hopSec);
  assert.ok(est !== undefined);
  assert.ok(Math.abs(est.bpm - 120) <= 3, `estimated ${est.bpm}`);
  assert.ok(est.confidence > 0);

  const out = analyzeReferenceBuffer(SRC, wavOf(pcm));
  assert.ok("analysis" in out);
  assert.ok(out.analysis.tempo !== undefined);
  assert.ok(Math.abs(out.analysis.tempo!.value - 120) <= 3);
  assert.ok(out.analysis.durationBeats !== undefined);
  // With a tempo, density/rhythmicActivity exist; they must not be fabricated.
  assert.ok(out.analysis.features.rhythmicActivity !== undefined);
});

test("explicit tempo hint wins over estimation and reads confidence 1", () => {
  const out = analyzeReferenceBuffer(SRC, wavOf(clickTrack(120, 8)), { tempoBpm: 128 });
  assert.ok("analysis" in out);
  assert.equal(out.analysis.tempo?.value, 128);
  assert.equal(out.analysis.tempo?.confidence, 1);
});

test("no tempo evidence → tempo and beat-axis features stay undefined (no fabrication)", () => {
  // Steady noise: no onset periodicity at all.
  const pcm = { sampleRate: 44100, channels: 1, samples: noise(44100 * 10, 0.3, 5) };
  const out = analyzeReferenceBuffer(SRC, wavOf(pcm));
  assert.ok("analysis" in out);
  assert.equal(out.analysis.tempo, undefined);
  assert.equal(out.analysis.durationBeats, undefined);
  assert.equal(out.analysis.features.rhythmicActivity, undefined);
  assert.equal(out.analysis.features.density, undefined);
  // ...while tempo-independent features still have data.
  assert.ok(out.analysis.features.energy !== undefined);
  assert.ok(out.analysis.features.lowEnergy !== undefined);
  // Sections still exist — on the documented nominal beat grid.
  assert.ok(out.analysis.sections.length >= 1);
});

test("empty/silent audio → reference_empty", () => {
  const silent = { sampleRate: 44100, channels: 1, samples: new Float32Array(44100 * 4) };
  const out = analyzeReferenceBuffer(SRC, wavOf(silent));
  assert.ok("error" in out);
  assert.equal(out.error, "reference_empty");
});

test("very short audio (< one FFT frame) → reference_empty", () => {
  const tiny = { sampleRate: 44100, channels: 1, samples: noise(1000, 0.5, 9) };
  const out = analyzeReferenceBuffer(SRC, wavOf(tiny));
  assert.ok("error" in out);
  assert.equal(out.error, "reference_empty");
});

test("undecodable bytes → reference_analysis_failed", () => {
  const out = analyzeReferenceBuffer(SRC, Buffer.from("definitely not a wav file"));
  assert.ok("error" in out);
  assert.equal(out.error, "reference_analysis_failed");
});

test("unsupported container (mp3) → reference_analysis_failed with message", () => {
  const out = analyzeReferenceBuffer({ type: "audio_file", path: "/tmp/ref.mp3" }, Buffer.alloc(2048, 1));
  assert.ok("error" in out);
  assert.equal(out.error, "reference_analysis_failed");
  assert.match(out.message ?? "", /unsupported format/);
});

test("live_audio source → reference_unavailable (reserved, not faked)", () => {
  const out = analyzeReferenceBuffer({ type: "live_audio", trackId: "3" }, Buffer.alloc(2048));
  assert.ok("error" in out);
  assert.equal(out.error, "reference_unavailable");
});

test("truncation by maxSeconds → partial + honest duration coverage", () => {
  const buf = wavOf(pcmOfSegments([[0.3, 10]]));
  const out = analyzeReferenceBuffer(SRC, buf, { maxSeconds: 5 });
  assert.ok("analysis" in out);
  assert.equal(out.analysis.partial, true);
  assert.ok(out.analysis.coverage.duration > 0.4 && out.analysis.coverage.duration < 0.6);
  assert.equal(out.analysis.durationSeconds, 5);
});

test("coverage values stay within 0..1 and section ids are deterministic", () => {
  const out = analyzeReferenceBuffer(SRC, wavOf(pcmOfSegments([[0.02, 8], [0.5, 8], [0.02, 8]])));
  assert.ok("analysis" in out);
  const c = out.analysis.coverage;
  for (const v of [c.duration, c.analyzedBeats, c.featureCoverage, c.sectionCoverage]) {
    assert.ok(v >= 0 && v <= 1, `coverage value ${v} out of range`);
  }
  out.analysis.sections.forEach((s, i) => assert.equal(s.id, `reference:section:${i}`));
});
