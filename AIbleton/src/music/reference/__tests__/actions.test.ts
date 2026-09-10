/**
 * actions.test.ts — conservative gap → CreativeAction mapping: which metrics
 * map, which never do, confidence/strength gates, dedup, cap, provenance.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveReferenceActions, MAX_REFERENCE_ACTIONS } from "../actions.js";
import { deriveReferenceGaps } from "../gap.js";
import { curSection, fv, refSection } from "./fixtures.js";
import type { ReferenceGap } from "../types.js";

function gapsOf(cur: Parameters<typeof deriveReferenceGaps>[0], ref: Parameters<typeof deriveReferenceGaps>[1]) {
  return deriveReferenceGaps(cur, ref, { alignmentConfidence: 0.9 });
}

test("Fixture A: energy/density/rhythm gaps map to the increase trio", () => {
  const cur = curSection("3", "Drop 2", {
    energy: fv(0.6),
    density: 2,
    rhythmicActivity: fv(0.5),
  });
  const ref = refSection(1, {
    features: { energy: fv(0.8), density: fv(7), rhythmicActivity: fv(0.75) },
  });
  const kinds = deriveReferenceActions(gapsOf(cur, ref)).map((a) => a.kind);
  assert.ok(kinds.includes("increase_energy"));
  assert.ok(kinds.includes("increase_density"));
  assert.ok(kinds.includes("increase_rhythmic_activity"));
});

test("Fixture B: a tiny energy difference produces no action", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.8) });
  const ref = refSection(1, { features: { energy: fv(0.82) } });
  assert.deepEqual(deriveReferenceActions(gapsOf(cur, ref)), []);
});

test("lower_in_reference maps to the decrease counterpart", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.9) });
  const ref = refSection(1, { features: { energy: fv(0.5) } });
  const kinds = deriveReferenceActions(gapsOf(cur, ref)).map((a) => a.kind);
  assert.deepEqual(kinds, ["decrease_energy"]);
});

test("low-confidence gaps stay evidence (no action)", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6, 0.4) });
  const ref = refSection(1, { features: { energy: fv(0.85, 0.4) } });
  assert.deepEqual(deriveReferenceActions(gapsOf(cur, ref)), []);
});

test("variation higher in reference → introduce_variation", () => {
  const cur = curSection("3", "Drop 2", { variation: 0.2 });
  const ref = refSection(1, { features: { variation: fv(0.5) } });
  const kinds = deriveReferenceActions(gapsOf(cur, ref)).map((a) => a.kind);
  assert.deepEqual(kinds, ["introduce_variation"]);
});

test("section_contrast higher in reference → increase_section_contrast", () => {
  const prev = curSection("2", "Build 2", { energy: fv(0.5) });
  const cur = curSection("3", "Drop 2", { energy: fv(0.7) });
  const refPrev = refSection(0, { features: { energy: fv(0.4) } });
  const ref = refSection(1, { features: { energy: fv(0.95) } });
  const gaps = deriveReferenceGaps(cur, ref, {
    currentPrev: prev,
    referencePrev: refPrev,
    alignmentConfidence: 0.9,
  });
  const kinds = deriveReferenceActions(gaps).map((a) => a.kind);
  assert.ok(kinds.includes("increase_section_contrast"));
});

test("mix/mastering-sensitive metrics NEVER map (evidence only)", () => {
  const cur = curSection("3", "Drop 2", {
    lowEnergy: fv(0.2),
    spectralBrightness: fv(0.3),
    dynamicRange: fv(6),
    tension: fv(0.3),
    release: fv(0.3),
  });
  const ref = refSection(1, {
    features: {
      lowEnergy: fv(0.5),
      spectralBrightness: fv(0.7),
      dynamicRange: fv(14),
      tension: fv(0.8),
      release: fv(0.8),
    },
  });
  // All five gaps are meaningful (+0.3/+0.4/+8/+0.5/+0.5) — none may map.
  assert.deepEqual(deriveReferenceActions(gapsOf(cur, ref)), []);
});

test("actions carry the reference_gap provenance chain (never source-less)", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6) });
  const ref = refSection(1, { features: { energy: fv(0.85) } });
  const [a] = deriveReferenceActions(gapsOf(cur, ref));
  assert.equal(a.sourceObservations.length, 1);
  const obs = a.sourceObservations[0];
  assert.equal(obs.kind, "reference_gap");
  assert.equal(obs.sectionId, "3");
  assert.equal(obs.relatedSectionId, "reference:section:1");
  assert.equal(obs.evidence[0].metric, "reference.energy");
  assert.equal(obs.evidence[0].value, 0.6);
  assert.equal(obs.evidence[0].relatedValue, 0.85);
  assert.equal(a.target.sectionId, "3");
  assert.equal(a.dimension, "energy");
});

test("ranking: strength first, then confidence, capped at MAX_REFERENCE_ACTIONS", () => {
  // Six mapped metrics with meaningful gaps — one over the cap.
  const gaps: ReferenceGap[] = (
    [
      ["energy", 0.5, 0.9],
      ["density", 0.4, 0.85],
      ["rhythmic_activity", 0.3, 0.8],
      ["active_track_ratio", 0.25, 0.75],
      ["impact", 0.2, 0.7],
      ["variation", 0.15, 0.65],
    ] as const
  ).map(([metric, strength, confidence]) => ({
    metric: metric as ReferenceGap["metric"],
    current: { value: 0.3, source: "derived" as const },
    reference: { value: 0.3 + strength * 0.4, source: "audio" as const },
    delta: strength * 0.4,
    direction: "higher_in_reference" as const,
    strength,
    confidence,
    currentSectionId: "3",
    referenceSectionId: "reference:section:1",
  }));
  const actions = deriveReferenceActions(gaps);
  assert.equal(actions.length, MAX_REFERENCE_ACTIONS);
  // Strongest first; the weakest (variation 0.15) is cut.
  assert.equal(actions[0].kind, "increase_energy");
  assert.ok(!actions.some((a) => a.kind === "introduce_variation"));
});

test("duplicate kinds dedupe to the strongest candidate", () => {
  const mk = (strength: number): ReferenceGap => ({
    metric: "energy",
    current: { value: 0.3, source: "derived" },
    reference: { value: 0.7, source: "audio" },
    delta: 0.4,
    direction: "higher_in_reference",
    strength,
    confidence: 0.9,
    currentSectionId: "3",
    referenceSectionId: "reference:section:1",
  });
  const actions = deriveReferenceActions([mk(0.5), mk(0.9)]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].strength, 0.9);
});

test("deterministic: identical gaps → identical actions", () => {
  const cur = curSection("3", "Drop 2", { energy: fv(0.6), density: 2 });
  const ref = refSection(1, { features: { energy: fv(0.85), density: fv(6) } });
  assert.deepEqual(deriveReferenceActions(gapsOf(cur, ref)), deriveReferenceActions(gapsOf(cur, ref)));
});
