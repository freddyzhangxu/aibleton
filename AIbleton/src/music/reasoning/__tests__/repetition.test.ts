import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRepetitionObservations, EVOLUTION_EPS } from "../repetition.js";
import { densityShapeSong, relate, velocityEvolutionSong } from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

test("identical pair → repeated_section_low_variation, strength = similarity", () => {
  const features = densityShapeSong([4, 4]);
  const obs = buildRepetitionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["repeated_section_low_variation"],
  );
  const o = obs[0];
  assert.equal(o.sectionId, "1");
  assert.equal(o.relatedSectionId, "0");
  assert.equal(o.strength, 1); // similarity 1.0
  // weakest link: similarity coverage 4/7 (MIDI-only dims) vs energy 0.5.
  assert.equal(o.confidence, 0.5);
  // Evidence walks back to both sides of every measured dimension.
  assert.deepEqual(
    o.evidence.map((e) => e.metric),
    [
      "sections[1].energy",
      "sections[1].density",
      "sections[1].activeTrackRatio",
      "sections[1].rhythmicActivity",
    ],
  );
});

test("velocity-only difference → repeat kind but WITH evolution (energy is not a similarity dim)", () => {
  const features = velocityEvolutionSong(60, 120);
  const rel = relate(features);
  assert.equal(rel.similarities[0].kind, "repeat"); // precondition
  const obs = buildRepetitionObservations(features, rel);
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["repeated_section_with_evolution"],
  );
  const o = obs[0];
  const energyEvidence = o.evidence.find((e) => e.metric === "sections[1].energy");
  assert.ok(energyEvidence?.delta !== undefined);
  // velocity 60→120 moves energyMidi by 0.25 × (120−60)/127.
  close(energyEvidence.delta, 0.25 * (60 / 127));
  assert.ok(energyEvidence.delta > EVOLUTION_EPS);
  close(o.strength, energyEvidence.delta / 0.3);
  assert.equal(o.confidence, 0.5);
});

test("first↔last alike in a 3+ section song → section_reprise on top of the pair reading", () => {
  const features = densityShapeSong([4, 1, 4]);
  const obs = buildRepetitionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => [o.kind, o.sectionId, o.relatedSectionId]),
    [
      // pair order: (0,1), (0,2), (1,2)
      ["repeated_section_with_evolution", "1", "0"], // density Δ 0.1875
      ["repeated_section_low_variation", "2", "0"],
      ["section_reprise", "2", "0"],
      ["repeated_section_with_evolution", "2", "1"],
    ],
  );
  const reprise = obs[2];
  assert.equal(reprise.strength, 1); // first ≈ last exactly
  assert.equal(reprise.confidence, 4 / 7); // similarity coverage only
});

test("two-section song never reads reprise", () => {
  const features = densityShapeSong([4, 4]);
  const obs = buildRepetitionObservations(features, relate(features));
  assert.ok(obs.every((o) => o.kind !== "section_reprise"));
});

test("clearly different pairs stay silent", () => {
  const features = densityShapeSong([1, 16]);
  const rel = relate(features);
  assert.equal(rel.similarities[0].kind, "different"); // precondition
  assert.deepEqual(buildRepetitionObservations(features, rel), []);
});
