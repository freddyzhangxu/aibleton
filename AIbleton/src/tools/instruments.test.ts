import assert from "node:assert/strict";
import test from "node:test";

import {
  pickRandomMelodicInstrument,
  RANDOM_MELODIC_INSTRUMENTS,
} from "./instruments.js";

test("random melodic instrument selection stays inside the curated pool", () => {
  assert.equal(pickRandomMelodicInstrument(() => 0), "Analog");
  assert.equal(pickRandomMelodicInstrument(() => 0.999999), "Tension");
  assert.equal(pickRandomMelodicInstrument(() => 1), "Tension");
  assert.equal(pickRandomMelodicInstrument(() => -1), "Analog");

  for (let i = 0; i < 100; i++) {
    assert.ok(RANDOM_MELODIC_INSTRUMENTS.includes(pickRandomMelodicInstrument()));
  }
});
