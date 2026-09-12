/**
 * loop.test.ts — the PR19 exit decision: refine as a fourth gate outcome.
 * Precedence: pass > budget-stop > refine (gen_* gap, budgeted) > retry > stop.
 * A refine is bounded by AGENT_MAX_REFINEMENTS independently of the single
 * retry, and never fires without mutation budget.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MAX_REFINEMENTS,
  AGENT_MAX_RETRIES,
  gateAction,
  refineHasNewArtifact,
  type RefineState,
} from "../loop.js";

const refinable = (used: number): RefineState => ({ available: true, used });

test("met goal passes regardless of refine availability", () => {
  assert.equal(gateAction(true, 0, 5, refinable(0)), "pass");
});

test("unmet + refineable + budget → refine, capped by AGENT_MAX_REFINEMENTS", () => {
  assert.equal(gateAction(false, 0, 5, refinable(0)), "refine");
  assert.equal(gateAction(false, 0, 5, refinable(AGENT_MAX_REFINEMENTS - 1)), "refine");
  // Budget spent: falls through to the retry path.
  assert.equal(gateAction(false, 0, 5, refinable(AGENT_MAX_REFINEMENTS)), "retry");
});

test("refine beats retry while it is available", () => {
  // retries < MAX, refine still available → refine wins.
  assert.equal(gateAction(false, 0, 5, refinable(1)), "refine");
});

test("refine never fires without mutation budget", () => {
  assert.equal(gateAction(false, 0, 0, refinable(0)), "stop");
  assert.equal(gateAction(false, 0, 0), "stop");
});

test("unavailable refine falls back to the single retry, then stop", () => {
  assert.equal(gateAction(false, 0, 5, { available: false, used: 0 }), "retry");
  assert.equal(gateAction(false, 0, 5), "retry"); // no refine state at all
  assert.equal(gateAction(false, AGENT_MAX_RETRIES, 5, refinable(AGENT_MAX_REFINEMENTS)), "stop");
});

test("refineHasNewArtifact: a refine only burns budget on a NEWER artifact", () => {
  // First gate of the turn: artifact exists, no refine seen yet → eligible.
  assert.equal(refineHasNewArtifact("gen-a", undefined), true);
  // After firing refine against gen-a, a text-only answer shows gen-a again
  // → NOT eligible (the counter must not burn on nothing).
  assert.equal(refineHasNewArtifact("gen-a", "gen-a"), false);
  // The model regenerated → a newer id is eligible again.
  assert.equal(refineHasNewArtifact("gen-b", "gen-a"), true);
  // No artifact at all → nothing to refine against.
  assert.equal(refineHasNewArtifact(undefined, undefined), false);
  assert.equal(refineHasNewArtifact(undefined, "gen-a"), false);
});

test("deterministic across the full state space", () => {
  for (const met of [true, false])
    for (let r = 0; r <= AGENT_MAX_RETRIES + 1; r++)
      for (let m = 0; m <= 2; m++)
        for (let u = 0; u <= AGENT_MAX_REFINEMENTS + 1; u++)
          for (const available of [true, false]) {
            const a = gateAction(met, r, m, { available, used: u });
            const b = gateAction(met, r, m, { available, used: u });
            assert.equal(a, b);
          }
});
