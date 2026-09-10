/**
 * integration.test.ts — the pure pipeline end to end, no layer mocked:
 *
 *   snapshot → MusicState → MusicalFeatures → MusicalRelationships
 *   → MusicalReasoning → CreativeActionSet
 *
 * The canonical repeat pair (two feature-identical sections) must read
 * repeated_section_low_variation in reasoning AND surface
 * introduce_variation as an action — the "why" chain intact all the way
 * down. A healthy evolving arrangement stays silent: zero actions is a
 * valid, honest answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMusicalReasoning } from "../../reasoning/index.js";
import { deriveCreativeActions } from "../index.js";
import { densityShapeSong, relate, velocityEvolutionSong } from "../../reasoning/__tests__/fixtures.js";

test("identical repeat pair → introduce_variation on the later section", () => {
  const features = densityShapeSong([4, 4]);
  const reasoning = buildMusicalReasoning(features, relate(features));

  // Precondition: the reasoning layer sees the low-variation repeat.
  const source = reasoning.observations.find(
    (o) => o.kind === "repeated_section_low_variation",
  );
  assert.ok(source, "fixture no longer produces repeated_section_low_variation");

  const set = deriveCreativeActions(reasoning);
  const action = set.actions.find((a) => a.kind === "introduce_variation");
  assert.ok(action, "no introduce_variation candidate surfaced");
  assert.equal(action.target.scope, "section");
  assert.equal(action.target.sectionId, source.sectionId); // "1" — the later section
  assert.equal(action.target.relatedSectionId, source.relatedSectionId); // "0"
  assert.equal(action.strength, source.strength);
  // The why-chain: action → the very observation → its evidence → features.
  assert.equal(action.sourceObservations[0], source);
  assert.ok(action.sourceObservations[0].evidence.length > 0);
});

test("evolving repeat → NO corrective action (repetition with evolution is not a problem)", () => {
  const features = velocityEvolutionSong(60, 120);
  const reasoning = buildMusicalReasoning(features, relate(features));
  assert.ok(
    reasoning.observations.some((o) => o.kind === "repeated_section_with_evolution"),
    "fixture no longer produces repeated_section_with_evolution",
  );
  const set = deriveCreativeActions(reasoning);
  assert.ok(
    set.actions.every((a) => a.kind !== "introduce_variation"),
    "evolution 'fixed' anyway",
  );
});

test("pipeline determinism: same song → byte-identical action set", () => {
  const run = () => {
    const features = densityShapeSong([4, 4]);
    return JSON.stringify(deriveCreativeActions(buildMusicalReasoning(features, relate(features))));
  };
  assert.equal(run(), run());
});
