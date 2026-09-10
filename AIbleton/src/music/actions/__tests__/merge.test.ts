/**
 * merge.test.ts — dedupe identity and merge semantics, subordination
 * (introduce_variation beats develop_section on the same pair) and
 * opposition resolution (stronger wins, ties surface neither).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveCreativeActions } from "../index.js";
import { OPPOSITION_TIE_EPS } from "../mappings.js";
import { mergeCreativeActions, resolveConflicts } from "../merge.js";
import { candidate, obs, reasoningOf } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

test("same kind + same target merges into one action", () => {
  const o1 = obs("weak_contrast", 0.5, { confidence: 0.6 });
  const o2 = obs("weak_contrast", 0.7, { confidence: 0.4 });
  const merged = mergeCreativeActions([
    candidate("increase_section_contrast", 0.5, { scope: "song" }, { sourceObservations: [o1], confidence: 0.6 }),
    candidate("increase_section_contrast", 0.7, { scope: "song" }, { sourceObservations: [o2], confidence: 0.4 }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].strength, 0.7);
  assert.equal(merged[0].confidence, 0.4);
  assert.deepEqual(merged[0].sourceObservations, [o1, o2]);
});

test("merge: strength takes the max, sources union in emission order", () => {
  const o1 = obs("weak_contrast", 0.5);
  const o2 = obs("weak_contrast", 0.7);
  const set = deriveCreativeActions(reasoningOf([o1, o2]));
  const a = set.actions.find((x) => x.kind === "increase_section_contrast")!;
  assert.equal(a.strength, 0.7);
  assert.deepEqual(a.sourceObservations, [o1, o2]);
});

test("same kind + different target stays separate", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("repeated_section_low_variation", 0.8, { sectionId: "3", relatedSectionId: "1" }),
      obs("repeated_section_low_variation", 0.6, { sectionId: "5", relatedSectionId: "4" }),
    ]),
  );
  const variations = set.actions.filter((a) => a.kind === "introduce_variation");
  assert.equal(variations.length, 2);
  assert.deepEqual(
    variations.map((a) => a.target.sectionId).sort(),
    ["3", "5"],
  );
});

test("merge: confidence is the weakest link of the defined ones", () => {
  const o1 = obs("weak_contrast", 0.5, { confidence: 0.6 });
  const o2 = obs("weak_contrast", 0.7, { confidence: 0.4 });
  const set = deriveCreativeActions(reasoningOf([o1, o2]));
  assert.equal(
    set.actions.find((a) => a.kind === "increase_section_contrast")!.confidence,
    0.4,
  );
});

test("merge: one missing confidence still yields the defined one; both missing → undefined", () => {
  const partial = deriveCreativeActions(
    reasoningOf([obs("weak_contrast", 0.5), obs("weak_contrast", 0.7, { confidence: 0.4 })]),
  );
  assert.equal(
    partial.actions.find((a) => a.kind === "increase_section_contrast")!.confidence,
    0.4,
  );
  const none = deriveCreativeActions(
    reasoningOf([obs("weak_contrast", 0.5), obs("weak_contrast", 0.7)]),
  );
  const a = none.actions.find((x) => x.kind === "increase_section_contrast")!;
  assert.equal(a.confidence, undefined);
  assert.ok(!("confidence" in a));
});

// ---------------------------------------------------------------------------
// Subordination — precise beats vague on the same pair
// ---------------------------------------------------------------------------

test("reprise + low-variation pair → introduce_variation wins, develop_section drops", () => {
  const set = deriveCreativeActions(
    reasoningOf([
      obs("repeated_section_low_variation", 0.9, { sectionId: "4", relatedSectionId: "0" }),
      obs("section_reprise", 0.95, { sectionId: "4", relatedSectionId: "0" }),
    ]),
  );
  assert.deepEqual(
    set.actions.map((a) => a.kind),
    ["introduce_variation"],
  );
});

test("develop_section survives on a pair with NO introduce_variation", () => {
  const resolved = resolveConflicts([
    candidate("develop_section", 0.4, { scope: "section", sectionId: "5", relatedSectionId: "2" }),
    candidate("introduce_variation", 0.9, { scope: "section", sectionId: "3", relatedSectionId: "1" }),
  ]);
  assert.deepEqual(
    resolved.map((a) => a.kind).sort(),
    ["develop_section", "introduce_variation"],
  );
});

// ---------------------------------------------------------------------------
// Opposition — same target, opposite kinds
// ---------------------------------------------------------------------------

const LAYER_TARGET = { scope: "section" as const, sectionId: "2", relatedSectionId: "1" };

test("opposition: clearly stronger candidate wins", () => {
  const resolved = resolveConflicts([
    candidate("increase_layering", 0.7, LAYER_TARGET),
    candidate("decrease_layering", 0.5, LAYER_TARGET),
  ]);
  assert.deepEqual(
    resolved.map((a) => a.kind),
    ["increase_layering"],
  );
});

test("opposition: the weaker side wins when IT is stronger", () => {
  const resolved = resolveConflicts([
    candidate("increase_layering", 0.4, LAYER_TARGET),
    candidate("decrease_layering", 0.6, LAYER_TARGET),
  ]);
  assert.deepEqual(
    resolved.map((a) => a.kind),
    ["decrease_layering"],
  );
});

test("opposition: an effective tie (≤ OPPOSITION_TIE_EPS) surfaces NEITHER", () => {
  assert.equal(OPPOSITION_TIE_EPS, 0.05); // the named, documented constant
  const resolved = resolveConflicts([
    candidate("increase_layering", 0.6, LAYER_TARGET),
    candidate("decrease_layering", 0.58, LAYER_TARGET), // diff 0.02 — a tie
  ]);
  assert.deepEqual(resolved, []);
});

test("opposition: exactly OPPOSITION_TIE_EPS is still a tie; just above resolves", () => {
  const atEps = resolveConflicts([
    candidate("increase_layering", 0.6, LAYER_TARGET),
    candidate("decrease_layering", 0.6 - OPPOSITION_TIE_EPS, LAYER_TARGET),
  ]);
  assert.deepEqual(atEps, []);
  const above = resolveConflicts([
    candidate("increase_layering", 0.6, LAYER_TARGET),
    candidate("decrease_layering", 0.6 - OPPOSITION_TIE_EPS - 0.01, LAYER_TARGET),
  ]);
  assert.deepEqual(
    above.map((a) => a.kind),
    ["increase_layering"],
  );
});

test("opposition: different targets do NOT collide", () => {
  const resolved = resolveConflicts([
    candidate("increase_layering", 0.6, { scope: "section", sectionId: "2" }),
    candidate("decrease_layering", 0.6, { scope: "section", sectionId: "4" }),
  ]);
  assert.equal(resolved.length, 2);
});

test("opposition: increase_repetition ↔ introduce_variation is an opposite pair", () => {
  const resolved = resolveConflicts([
    candidate("increase_repetition", 0.7, LAYER_TARGET),
    candidate("introduce_variation", 0.7, LAYER_TARGET),
  ]);
  assert.deepEqual(resolved, []); // dead tie → neither
});
