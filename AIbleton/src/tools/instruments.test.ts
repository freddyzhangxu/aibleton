import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INSTRUMENT_BY_ROLE,
} from "./instruments.js";

test("provides stable Live instrument defaults for common melodic roles", () => {
  assert.deepEqual(DEFAULT_INSTRUMENT_BY_ROLE, {
    bass: "Operator",
    pad: "Wavetable",
    lead: "Drift",
    melody: "Drift",
  });
});
