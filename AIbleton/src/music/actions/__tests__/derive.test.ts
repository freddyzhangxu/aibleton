/**
 * derive.test.ts — the mapping table itself: which observations produce
 * which candidates, the neutrality rules (directionals are NEVER inverted),
 * evidence preservation, strength/confidence propagation, and the
 * unknown/empty honesty cases. End-to-end deriveCreativeActions unless the
 * stage under test is deriveCandidates itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveCreativeActions } from "../index.js";
import { LOW_STRENGTH_FACTOR } from "../mappings.js";
import { obs, reasoningOf } from "./fixtures.js";

// ---------------------------------------------------------------------------
// A. Direct semantic mappings
// ---------------------------------------------------------------------------

test("weak_contrast → increase_section_contrast (song scope, strength kept)", () => {
  // All three MIDI-derived increase kinds present → the absence-gated
  // supporting candidates stay silent; only the primary fires.
  const set = deriveCreativeActions(
    reasoningOf([
      obs("weak_contrast", 0.72, { confidence: 0.5 }),
      obs("layer_increase", 0.4, { sectionId: "1", relatedSectionId: "0" }),
      obs("density_increase", 0.4, { sectionId: "1", relatedSectionId: "0" }),
      obs("rhythmic_increase", 0.4, { sectionId: "1", relatedSectionId: "0" }),
    ]),
  );
  assert.deepEqual(
    set.actions.map((a) => a.kind),
    ["increase_section_contrast"],
  );
  const a = set.actions[0];
  assert.equal(a.target.scope, "song");
  assert.equal(a.target.sectionId, undefined); // song-level observation carries no ids
  assert.equal(a.strength, 0.72);
  assert.equal(a.confidence, 0.5);
  assert.equal(a.dimension, "contrast");
});

test("weak_contrast alone → primary + each independently-gated supporting candidate", () => {
  const set = deriveCreativeActions(reasoningOf([obs("weak_contrast", 0.6)]));
  assert.deepEqual(
    set.actions.map((a) => a.kind).sort(),
    [
      "increase_density",
      "increase_layering",
      "increase_rhythmic_activity",
      "increase_section_contrast",
    ],
  );
  // Every supporting candidate stands on the SAME single observation.
  for (const a of set.actions) {
    assert.equal(a.strength, 0.6);
    assert.deepEqual(
      a.sourceObservations.map((o) => o.kind),
      ["weak_contrast"],
    );
  }
});

test("absence gates are independent: layer growth silences only increase_layering", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("weak_contrast", 0.6),
      obs("layer_increase", 0.3, { sectionId: "2", relatedSectionId: "1" }),
    ]),
  );
  assert.deepEqual(
    set.actions.map((a) => a.kind).sort(),
    ["increase_density", "increase_rhythmic_activity", "increase_section_contrast"],
  );
});

test("repeated_section_low_variation → introduce_variation on the LATER section", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("repeated_section_low_variation", 0.81, {
        sectionId: "5",
        relatedSectionId: "3",
        confidence: 0.66,
      }),
    ]),
  );
  assert.equal(set.actions.length, 1);
  const a = set.actions[0];
  assert.equal(a.kind, "introduce_variation");
  assert.deepEqual(a.target, { scope: "section", sectionId: "5", relatedSectionId: "3" });
  assert.equal(a.strength, 0.81);
  assert.equal(a.confidence, 0.66);
  assert.equal(a.dimension, "variation");
});

test("limited_energy_cycle → strengthen_breakdown (structural, never a volume action)", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("limited_energy_cycle", 0.9, { sectionId: "2", relatedSectionId: "4" }),
    ]),
  );
  assert.equal(set.actions.length, 1);
  const a = set.actions[0];
  assert.equal(a.kind, "strengthen_breakdown");
  assert.equal(a.target.scope, "song");
  assert.equal(a.target.sectionId, "2"); // ids carried for provenance
  assert.equal(a.target.relatedSectionId, "4");
  assert.equal(a.dimension, "structure");
});

test("section_reprise alone → nothing (a plain reprise is not a problem)", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("section_reprise", 0.95, { sectionId: "4", relatedSectionId: "0" })]),
  );
  assert.deepEqual(set.actions, []);
});

test("repeated_peak → develop_section at LOW strength only", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("repeated_peak", 0.8, { sectionId: "2", relatedSectionId: "5" })]),
  );
  assert.equal(set.actions.length, 1);
  const a = set.actions[0];
  assert.equal(a.kind, "develop_section");
  assert.equal(a.strength, 0.8 * LOW_STRENGTH_FACTOR);
  assert.deepEqual(a.target, { scope: "section", sectionId: "2", relatedSectionId: "5" });
});

// ---------------------------------------------------------------------------
// B. No-action observations — silence is the mapped answer
// ---------------------------------------------------------------------------

for (const kind of [
  "strong_contrast",
  "clear_build",
  "clear_breakdown",
  "repeated_section_with_evolution",
  "breakdown_after_peak",
  "energy_recovery",
  "strong_rhythmic_foundation",
  "low_frequency_co_activity",
] as const) {
  test(`${kind} → no action`, () => {
    const set = deriveCreativeActions(
      reasoningOf([obs(kind, 0.9, { sectionId: "1", relatedSectionId: "0" })]),
    );
    assert.deepEqual(set.actions, []);
  });
}

// ---------------------------------------------------------------------------
// C. Directional neutrality — the most important group: descriptive facts
// are never inverted into corrections.
// ---------------------------------------------------------------------------

test("energy_decrease alone → NO increase_energy (a drop may be exactly right)", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("energy_decrease", 0.8, { sectionId: "3", relatedSectionId: "2" })]),
  );
  assert.deepEqual(set.actions, []);
});

test("energy_increase alone → NO decrease_energy", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("energy_increase", 0.8, { sectionId: "3", relatedSectionId: "2" })]),
  );
  assert.deepEqual(set.actions, []);
});

test("rhythmic_decrease alone → no automatic opposite action", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("rhythmic_decrease", 0.55, { sectionId: "3", relatedSectionId: "2" })]),
  );
  assert.deepEqual(set.actions, []);
});

test("directionals alongside weak_contrast still produce no inverted energy action", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("weak_contrast", 0.6),
      obs("energy_decrease", 0.8, { sectionId: "3", relatedSectionId: "2" }),
      obs("rhythmic_decrease", 0.5, { sectionId: "3", relatedSectionId: "2" }),
    ]),
  );
  assert.ok(set.actions.every((a) => a.kind !== "increase_energy"));
  assert.ok(set.actions.every((a) => a.kind !== "decrease_rhythmic_activity"));
});

// ---------------------------------------------------------------------------
// D. Evidence preservation
// ---------------------------------------------------------------------------

test("every action carries ≥1 source observation, by reference, evidence intact", () => {
  const o = obs("repeated_section_low_variation", 0.81, {
    sectionId: "5",
    relatedSectionId: "3",
    evidence: [{ metric: "sections[5].density", value: 8, relatedValue: 8, delta: 0 }],
  });
  const set = deriveCreativeActions(reasoningOf([o]));
  for (const a of set.actions) {
    assert.ok(a.sourceObservations.length >= 1);
  }
  const src = set.actions[0].sourceObservations[0];
  assert.equal(src, o); // the very object — the provenance chain is unbroken
  assert.equal(src.evidence[0].metric, "sections[5].density");
  assert.equal(src.sectionId, "5");
});

// ---------------------------------------------------------------------------
// E. Confidence propagation (single source — merge cases live in merge.test)
// ---------------------------------------------------------------------------

test("single-source confidence propagates exactly", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("limited_energy_cycle", 0.9, { confidence: 0.42 })]),
  );
  assert.equal(set.actions[0].confidence, 0.42);
});

test("missing confidence stays undefined — never faked as 1", () => {
  const set = deriveCreativeActions(
    reasoningOf([obs("repeated_section_low_variation", 0.81, { sectionId: "1", relatedSectionId: "0" })]),
  );
  assert.equal(set.actions[0].confidence, undefined);
  assert.ok(!("confidence" in set.actions[0]));
});

// ---------------------------------------------------------------------------
// J. Unknown / empty
// ---------------------------------------------------------------------------

test("empty reasoning → empty actions, zero coverage", () => {
  const set = deriveCreativeActions(reasoningOf([]));
  assert.deepEqual(set.actions, []);
  assert.deepEqual(set.coverage, { sourceObservations: 0, actionableObservations: 0 });
});

test("unsupported observation kinds produce no fabricated candidates", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("energy_flat", 0.5, { sectionId: "1", relatedSectionId: "0" }),
      obs("layer_decrease", 0.5, { sectionId: "1", relatedSectionId: "0" }),
    ]),
  );
  assert.deepEqual(set.actions, []);
  assert.equal(set.coverage.sourceObservations, 2);
  assert.equal(set.coverage.actionableObservations, 0);
});

test("coverage counts mapped (actionable) observations, emitted or not", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("weak_contrast", 0.6), // mapped, emits
      obs("section_reprise", 0.9, { sectionId: "2", relatedSectionId: "0" }), // mapped, gated off
      obs("energy_decrease", 0.7, { sectionId: "1", relatedSectionId: "0" }), // unmapped
    ]),
  );
  assert.equal(set.coverage.sourceObservations, 3);
  assert.equal(set.coverage.actionableObservations, 2);
});

// ---------------------------------------------------------------------------
// I. Determinism
// ---------------------------------------------------------------------------

test("same reasoning in → deep-equal set out, across repeated calls", () => {
  const reasoning = reasoningOf([
    obs("weak_contrast", 0.6),
    obs("repeated_section_low_variation", 0.81, { sectionId: "5", relatedSectionId: "3" }),
    obs("energy_decrease", 0.5, { sectionId: "3", relatedSectionId: "2" }),
  ]);
  assert.deepEqual(deriveCreativeActions(reasoning), deriveCreativeActions(reasoning));
});

test("inputs are never mutated", () => {
  const reasoning = reasoningOf([
    obs("weak_contrast", 0.6),
    obs("repeated_section_low_variation", 0.81, { sectionId: "5", relatedSectionId: "3" }),
  ]);
  const before = JSON.stringify(reasoning);
  deriveCreativeActions(reasoning);
  assert.equal(JSON.stringify(reasoning), before);
});
