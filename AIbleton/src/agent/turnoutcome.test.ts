import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTurnGoalOutcome, setTurnGoalOutcome, turnGoalOutcome } from "./turnoutcome.js";

test("turn goal outcome is cleared between turns", () => {
  clearTurnGoalOutcome();
  assert.equal(turnGoalOutcome(), undefined);
  setTurnGoalOutcome({ status: "passed", objective: "Make a drop" });
  assert.equal(turnGoalOutcome()?.status, "passed");
  clearTurnGoalOutcome();
  assert.equal(turnGoalOutcome(), undefined);
});
