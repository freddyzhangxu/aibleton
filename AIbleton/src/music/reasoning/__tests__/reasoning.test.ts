import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildMusicalReasoning } from "../index.js";
import { OBSERVATION_KINDS } from "../types.js";
import { densityShapeSong, relate, snapshot } from "./fixtures.js";

test("full pipeline: fixed family order, honest coverage", () => {
  const features = densityShapeSong([4, 1, 4]);
  const reasoning = buildMusicalReasoning(features, relate(features));

  assert.deepEqual(reasoning.coverage, { sections: 3, analyzedSections: 3 });
  assert.deepEqual(
    reasoning.observations.map((o) => o.kind),
    [
      // section: transition 0→1, then 1→2 (energy → density → rhythmic each)
      "energy_flat",
      "density_decrease",
      "rhythmic_decrease",
      "energy_flat",
      "density_increase",
      "rhythmic_increase",
      // arrangement: range 0.094 < ARC_FLAT_RANGE → flat projection only
      "weak_contrast",
      // repetition: pairs (0,1), (0,2), (1,2)
      "repeated_section_with_evolution",
      "repeated_section_low_variation",
      "section_reprise",
      "repeated_section_with_evolution",
      // track: no role labels → silent
    ],
  );
});

test("determinism: same inputs → byte-identical output", () => {
  const features = densityShapeSong([16, 1, 16, 1]);
  const a = buildMusicalReasoning(features, relate(features));
  const b = buildMusicalReasoning(features, relate(features));
  assert.deepEqual(a, b);
});

test("empty set: no observations, zero coverage — never a fabricated fact", () => {
  const features = buildMusicalFeatures(buildMusicState(snapshot([])));
  const reasoning = buildMusicalReasoning(features, relate(features));
  assert.deepEqual(reasoning.observations, []);
  assert.deepEqual(reasoning.coverage, { sections: 0, analyzedSections: 0 });
});

test("every emitted kind is in the closed vocabulary, with refs and evidence", () => {
  const features = densityShapeSong([16, 1, 16, 1]);
  const reasoning = buildMusicalReasoning(features, relate(features));
  assert.ok(reasoning.observations.length > 0);
  for (const o of reasoning.observations) {
    assert.ok((OBSERVATION_KINDS as readonly string[]).includes(o.kind), o.kind);
    assert.ok(o.strength >= 0 && o.strength <= 1, `${o.kind} strength ${o.strength}`);
    if (o.confidence !== undefined) {
      assert.ok(o.confidence >= 0 && o.confidence <= 1, `${o.kind} confidence`);
    }
    assert.ok(o.evidence.length > 0, `${o.kind} must carry its evidence chain`);
    for (const e of o.evidence) {
      assert.match(e.metric, /^(sections\[\d+\]|tracks\[\d+\]|song)\.[a-zA-Z]+$/);
    }
  }
});
