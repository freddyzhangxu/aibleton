/**
 * rank.test.ts — ordering criteria in priority order, tie stability, and
 * the candidate cap. Literal candidates: ranking is a pure list transform.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveCreativeActions } from "../index.js";
import { MAX_CREATIVE_ACTIONS, rankCreativeActions } from "../rank.js";
import { candidate, obs, reasoningOf } from "./fixtures.js";

test("higher strength ranks first", () => {
  const ranked = rankCreativeActions([
    candidate("increase_density", 0.4),
    candidate("introduce_variation", 0.9),
    candidate("strengthen_breakdown", 0.6),
  ]);
  assert.deepEqual(
    ranked.map((a) => [a.kind, a.strength]),
    [
      ["introduce_variation", 0.9],
      ["strengthen_breakdown", 0.6],
      ["increase_density", 0.4],
    ],
  );
});

test("equal strength: higher confidence wins when BOTH carry one", () => {
  const ranked = rankCreativeActions([
    candidate("increase_density", 0.5, {}, { confidence: 0.4 }),
    candidate("increase_layering", 0.5, {}, { confidence: 0.8 }),
  ]);
  assert.deepEqual(
    ranked.map((a) => a.kind),
    ["increase_layering", "increase_density"],
  );
});

test("equal strength: a missing confidence is UNKNOWN, not a loss", () => {
  // One side has no confidence → the criterion is skipped; derivation
  // order decides instead of treating undefined as 0.
  const ranked = rankCreativeActions([
    candidate("increase_density", 0.5), // no confidence, derived first
    candidate("increase_layering", 0.5, {}, { confidence: 0.8 }),
  ]);
  assert.deepEqual(
    ranked.map((a) => a.kind),
    ["increase_density", "increase_layering"],
  );
});

test("equal strength+confidence: the more specific target wins", () => {
  const ranked = rankCreativeActions([
    candidate("strengthen_breakdown", 0.5, { scope: "song" }),
    candidate("introduce_variation", 0.5, {
      scope: "section",
      sectionId: "5",
      relatedSectionId: "3",
    }),
  ]);
  assert.deepEqual(
    ranked.map((a) => a.kind),
    ["introduce_variation", "strengthen_breakdown"],
  );
});

test("exact ties keep derivation order — ranking is stable", () => {
  const a = candidate("introduce_variation", 0.5, { scope: "section", sectionId: "5" });
  const b = candidate("introduce_variation", 0.5, { scope: "section", sectionId: "5" });
  assert.deepEqual(rankCreativeActions([a, b]), [a, b]);
});

test("strength ties across kinds resolve by derivation order, not kind name", () => {
  const ranked = rankCreativeActions([
    candidate("introduce_variation", 0.5, { scope: "song" }),
    candidate("increase_energy", 0.5, { scope: "song" }),
  ]);
  assert.deepEqual(
    ranked.map((a) => a.kind),
    ["introduce_variation", "increase_energy"],
  );
  // (Criterion 5 — vocabulary order — sits behind the derivation index in
  // the comparator as the always-defined last resort; two distinct
  // candidates never share an index, so it is defensive by construction.)
});

test("the cap is respected — and zero actions is valid", () => {
  const many = Array.from({ length: MAX_CREATIVE_ACTIONS + 4 }, (_, i) =>
    candidate("increase_density", 1 - i * 0.01, { scope: "section", sectionId: String(i) }),
  );
  const ranked = rankCreativeActions(many);
  assert.equal(ranked.length, many.length); // rank itself does not cut…
  // …the cap lives in the public pipeline.
  const reasoning = reasoningOf(
    Array.from({ length: 12 }, (_, i) =>
      obs("repeated_section_low_variation", 0.9 - i * 0.01, {
        sectionId: String(i + 1),
        relatedSectionId: String(i),
      }),
    ),
  );
  const set = deriveCreativeActions(reasoning);
  assert.equal(set.actions.length, MAX_CREATIVE_ACTIONS);
  // Strongest first under the cap.
  assert.equal(set.actions[0].strength, 0.9);
  assert.equal(set.actions[MAX_CREATIVE_ACTIONS - 1].strength, 0.9 - 0.07);
});

test("ranking never mutates its input", () => {
  const input = [
    candidate("increase_density", 0.4),
    candidate("introduce_variation", 0.9),
  ];
  const before = JSON.stringify(input);
  rankCreativeActions(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(input[0].kind, "increase_density"); // order untouched too
});
