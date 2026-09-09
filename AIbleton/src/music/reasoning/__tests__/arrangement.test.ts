import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArrangementObservations, ENERGY_CYCLE_FALL } from "../arrangement.js";
import { densityShapeSong, relate } from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

// Section energies of densityShapeSong (MIDI-only: energyMidi alone):
//   density  1 → 0.478…, density 4 → 0.572…, density 16 → 0.947…
const E1 = 0.4781003937007874;
const E16 = 0.9468503937007874;

test("rising song → clear_build + strong_contrast, peak referenced", () => {
  const features = densityShapeSong([1, 4, 16]);
  const obs = buildArrangementObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["clear_build", "strong_contrast"],
  );
  const [build, contrast] = obs;
  assert.equal(build.sectionId, "2"); // peak section
  assert.equal(build.strength, 1); // range 0.469 ≥ STRONG_CONTRAST_RANGE saturates
  assert.equal(build.confidence, 1); // all 3 sections have energy
  close(contrast.evidence[0].value, E16 - E1);
  close(contrast.strength, (E16 - E1) / 0.8);
});

test("flat song → weak_contrast only; peak family stays silent (prominence gate)", () => {
  const features = densityShapeSong([4, 4, 4]);
  const obs = buildArrangementObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["weak_contrast"],
  );
  assert.equal(obs[0].strength, 1); // range exactly 0
  assert.deepEqual(obs[0].evidence, [{ metric: "song.energyRange", value: 0 }]);
});

test("valley → breakdown_after_peak + energy_recovery + repeated_peak + strong_contrast", () => {
  const features = densityShapeSong([16, 1, 16]);
  const obs = buildArrangementObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["strong_contrast", "breakdown_after_peak", "energy_recovery", "repeated_peak"],
  );
  const [, breakdown, recovery, repeated] = obs;
  assert.equal(breakdown.sectionId, "1"); // the trough
  assert.equal(breakdown.relatedSectionId, "0"); // the (earliest) peak
  close(breakdown.evidence[0].delta, -(E16 - E1));
  assert.equal(breakdown.strength, 1); // dip 0.469 ≥ 2 × ENERGY_CYCLE_FALL
  assert.equal(recovery.sectionId, "2");
  assert.equal(recovery.relatedSectionId, "1");
  assert.equal(repeated.sectionId, "0");
  assert.equal(repeated.relatedSectionId, "2"); // the second peak
  assert.equal(repeated.strength, 0.5); // two peaks
});

test("peak that never comes down → limited_energy_cycle + repeated_peak", () => {
  const features = densityShapeSong([1, 16, 16]);
  const obs = buildArrangementObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["strong_contrast", "limited_energy_cycle", "repeated_peak"],
  );
  const cycle = obs[1];
  assert.equal(cycle.sectionId, "1"); // earliest peak
  assert.equal(cycle.relatedSectionId, "2"); // lowest post-peak section
  assert.equal(cycle.strength, 1); // never dips at all
  close(cycle.evidence[0].relatedValue, E16);
});

test("muted/unanalyzed songs produce no arrangement observations", () => {
  // density 0 sections only: energies are all 0 — defined, but flat and
  // with zero prominence → weak_contrast is the ONLY honest statement.
  const features = densityShapeSong([0, 0]);
  const obs = buildArrangementObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["weak_contrast"],
  );
});

test("breakdown vs limited cycle are exact complements post-peak", () => {
  for (const densities of [[1, 16, 1], [1, 16, 16], [16, 1, 16], [4, 16, 4, 16]]) {
    const features = densityShapeSong(densities);
    const obs = buildArrangementObservations(features, relate(features));
    const kinds = obs.map((o) => o.kind);
    const hasBreakdown = kinds.includes("breakdown_after_peak");
    const hasLimited = kinds.includes("limited_energy_cycle");
    // Every fixture here has a prominent peak with a post-peak section.
    assert.notEqual(hasBreakdown, hasLimited, `complement failed for ${densities}`);
  }
  assert.ok(ENERGY_CYCLE_FALL > 0); // anchors are exported for a reason
});
