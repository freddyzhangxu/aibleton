/**
 * chain.test.ts — buildMusicIntelligence IS the three layers chained:
 * identical outputs to calling the builders by hand, byte-identical across
 * runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicalRelationships } from "../../relationships/index.js";
import { buildMusicalReasoning } from "../../reasoning/index.js";
import { buildMusicIntelligence } from "../index.js";
import { buildDropSnapshot, rolesOf } from "./fixtures.js";

test("chain: output equals the three builders called by hand", () => {
  const state = buildMusicState(buildDropSnapshot());
  const analysis = rolesOf([0, "kick"], [1, "bass"]);

  const features = buildMusicalFeatures(state, analysis);
  const relationships = buildMusicalRelationships(features);
  const reasoning = buildMusicalReasoning(features, relationships);

  const intel = buildMusicIntelligence(state, analysis);
  assert.deepEqual(intel.features, features);
  assert.deepEqual(intel.relationships, relationships);
  assert.deepEqual(intel.reasoning, reasoning);
});

test("chain: deterministic — same state, byte-identical output", () => {
  const a = buildMusicIntelligence(buildMusicState(buildDropSnapshot()));
  const b = buildMusicIntelligence(buildMusicState(buildDropSnapshot()));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("chain: works without analysis (roles stay undefined, nothing faked)", () => {
  const intel = buildMusicIntelligence(buildMusicState(buildDropSnapshot()));
  assert.equal(intel.features.tracks[0].role, undefined);
  // Coverage honesty rides through untouched.
  assert.equal(intel.reasoning.coverage.sections, intel.features.sections.length);
});
