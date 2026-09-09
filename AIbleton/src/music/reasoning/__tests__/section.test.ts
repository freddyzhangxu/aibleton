import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import { buildSectionObservations } from "../section.js";
import {
  audioClip,
  densityShapeSong,
  fourOnFloor,
  midiClip,
  relate,
  snapshot,
  track,
} from "./fixtures.js";

const close = (v: number | undefined, expected: number, eps = 1e-9) => {
  assert.ok(v !== undefined, "expected a value");
  assert.ok(Math.abs(v - expected) < eps, `${v} ≉ ${expected}`);
};

test("identical sections → exactly one energy_flat, strength 1", () => {
  const features = densityShapeSong([4, 4]);
  const obs = buildSectionObservations(features, relate(features));
  assert.equal(obs.length, 1);
  const o = obs[0];
  assert.equal(o.kind, "energy_flat");
  assert.equal(o.sectionId, "1");
  assert.equal(o.relatedSectionId, "0");
  assert.equal(o.strength, 1); // delta exactly 0
  assert.equal(o.confidence, 0.5); // inherited from the contrast's energyDelta
  assert.deepEqual(o.evidence, [
    {
      metric: "sections[1].energy",
      value: features.sections[1].energy?.value,
      relatedValue: features.sections[0].energy?.value,
      delta: 0,
    },
  ]);
});

test("empty → dense: energy/density/layer increase, no rhythmic (empty side has none)", () => {
  const features = densityShapeSong([0, 16]);
  const obs = buildSectionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["energy_increase", "density_increase", "layer_increase"],
  );
  const [energy, density, layer] = obs;
  close(energy.evidence[0].delta, 0.9468503937007874);
  assert.equal(energy.strength, 1); // 0.947 / 0.5 saturates
  assert.equal(energy.confidence, 0.5);
  assert.deepEqual(density.evidence, [
    { metric: "sections[1].density", value: 16, relatedValue: 0, delta: 16 },
  ]);
  assert.equal(density.confidence, undefined); // raw MIDI fact: none to inherit
  assert.deepEqual(layer.evidence, [
    { metric: "sections[1].activeTrackRatio", value: 1, relatedValue: 0, delta: 1 },
  ]);
});

test("dense → empty: all three decrease", () => {
  const features = densityShapeSong([16, 0]);
  const obs = buildSectionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["energy_decrease", "density_decrease", "layer_decrease"],
  );
  assert.equal(obs[0].sectionId, "1");
  assert.equal(obs[0].relatedSectionId, "0");
});

test("small moves below the thresholds read flat / stay silent", () => {
  const features = densityShapeSong([4, 1]); // energy Δ −0.094 < eps, density Δ −0.1875
  const obs = buildSectionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["energy_flat", "density_decrease", "rhythmic_decrease"],
  );
  close(obs[0].strength, 1 - 0.09375 / 0.1); // energy_flat strength = "how flat"
  assert.equal(obs[0].confidence, 0.5);
});

test("unanalyzed audio section: NO energy observation — silence, not a fake flat", () => {
  const features = buildMusicalFeatures(
    buildMusicState(
      snapshot(
        [
          track(0, "Keys", "midi", [
            midiClip("k", fourOnFloor(1), { start: 0, duration: 32 }),
          ]),
          track(1, "Pad", "audio", [audioClip("p", { start: 32, duration: 32 })]),
        ],
        {
          cuePoints: [
            { time: 0, name: "A" },
            { time: 32, name: "B" },
          ],
        },
      ),
    ),
  );
  assert.equal(features.sections[1].energy, undefined); // precondition
  const obs = buildSectionObservations(features, relate(features));
  assert.deepEqual(
    obs.map((o) => o.kind),
    ["density_decrease"], // 4 → 0 onsets/bar; layer ½→½ stays silent
  );
});
