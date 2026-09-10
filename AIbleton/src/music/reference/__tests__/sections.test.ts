/**
 * sections.test.ts — boundary detection, minimum-length merging, role
 * inference, deterministic ids, honest unknowns.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeReferenceCurves } from "../analyze.js";
import { detectReferenceBoundaries, detectReferenceSections } from "../sections.js";
import { noise, pcmOfSegments } from "./fixtures.js";

const SR = 44100;
const secs = (frames: number): number => (frames * 1024) / SR;

test("level shifts produce boundaries at the segment edges", () => {
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 3], [0.01, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const { boundaries, strengths } = detectReferenceBoundaries(curves, { minSectionSec: 1 });
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries.length, 3);
  // ~3 s and ~6 s, ±0.3 s of curve-grid tolerance.
  assert.ok(Math.abs(secs(boundaries[1]) - 3) < 0.3, `boundary at ${secs(boundaries[1])}`);
  assert.ok(Math.abs(secs(boundaries[2]) - 6) < 0.3, `boundary at ${secs(boundaries[2])}`);
  assert.equal(strengths.length, 2);
  assert.ok(strengths.every((s) => s > 10), "a 0.01→0.6 step is a loud shift");
});

test("flat energy yields no interior boundaries (single section)", () => {
  const pcm = { sampleRate: SR, channels: 1, samples: noise(SR * 9, 0.3, 11) };
  const curves = computeReferenceCurves(pcm);
  const { boundaries } = detectReferenceBoundaries(curves, { minSectionSec: 1 });
  assert.deepEqual(boundaries, [0]);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].role, "unknown"); // one section → no relative evidence
});

test("sections shorter than the minimum merge into the closer-energy neighbour", () => {
  // quiet 3s | LOUD 1s | quiet 3s | quiet 3s — the 1s spike must merge away.
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 1], [0.01, 3], [0.012, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 2 });
  const spans = sections.map((s) => s.endBeat - s.startBeat);
  // Beats ride the nominal 120 grid here (2 beats/sec): every kept section ≥ 2 s.
  assert.ok(spans.every((sp) => sp >= 4 - 0.5), `spans ${spans}`);
  assert.ok(sections.length <= 3, `merged away: ${sections.length} sections left`);
});

test("role inference: quiet–loud–quiet reads intro/drop/outro with labels and ordinals", () => {
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 3], [0.01, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  assert.equal(sections.length, 3);
  assert.equal(sections[0].role, "intro");
  assert.equal(sections[1].role, "drop");
  assert.equal(sections[2].role, "outro");
  assert.equal(sections[1].label, "Drop 1");
  // Inferred, never certain: confidence is honest, not 1.
  for (const s of sections) {
    assert.ok(s.confidence >= 0 && s.confidence <= 0.95, `confidence ${s.confidence}`);
  }
});

test("duplicate roles get deterministic ordinals (Drop 1, Drop 2)", () => {
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 3], [0.02, 3], [0.55, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  const drops = sections.filter((s) => s.role === "drop");
  assert.equal(drops.length, 2);
  assert.equal(drops[0].label, "Drop 1");
  assert.equal(drops[1].label, "Drop 2");
});

test("equal-energy sections read unknown, never an invented role", () => {
  const pcm = pcmOfSegments([[0.3, 3], [0.3, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  assert.ok(sections.every((s) => s.role === "unknown"));
  assert.ok(sections.every((s) => s.label === undefined));
});

test("deterministic ids and full-span coverage", () => {
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 3], [0.01, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const a = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  const b = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  assert.deepEqual(a, b);
  a.forEach((s, i) => assert.equal(s.id, `reference:section:${i}`));
  assert.equal(a[0].startBeat, 0);
  // The last section ends at the end of the curve (nominal grid: 2 beats/s).
  assert.ok(Math.abs(a[a.length - 1].endBeat - 9 * 2) < 1);
});

test("every section carries the shared feature surface (energy/bands/brightness)", () => {
  const pcm = pcmOfSegments([[0.01, 3], [0.6, 3]], SR);
  const curves = computeReferenceCurves(pcm);
  const sections = detectReferenceSections(pcm, curves, { minSectionSec: 1 });
  for (const s of sections) {
    assert.ok(s.features.energy !== undefined);
    assert.ok(s.features.lowEnergy !== undefined);
    assert.ok(s.features.spectralBrightness !== undefined);
    // MIDI facts stay undefined on audio-only evidence (honesty rule 1).
    assert.equal(s.features.variation, undefined);
    assert.equal(s.features.repetition, undefined);
  }
});
