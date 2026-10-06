import assert from "node:assert/strict";
import test from "node:test";

import {
  executePlanSequentially,
  preflightExecutablePlan,
  resolvePlanReferences,
  type InputSchema,
} from "./execution.js";
import { normalizePlan, type PlanStep } from "./types.js";

const tempoSchema: InputSchema = {
  type: "object",
  properties: { bpm: { type: "number" } },
  required: ["bpm"],
  additionalProperties: false,
};

const schemas = new Map<string, InputSchema>([["set_tempo", tempoSchema]]);
const allowedTools = new Set(["set_tempo"]);

function step(id: string, args: Record<string, unknown>, tool = "set_tempo"): PlanStep {
  return { id, description: id, tool, args, expectedEffects: [] };
}

function executablePlan(rawSteps: unknown[], execute = true) {
  return normalizePlan({ execute, steps: rawSteps }, new Set(["set_tempo", "search_samples"]));
}

test("executable mode opts in only on literal true and preserves declaration-only args bounds", () => {
  const raw = [{ id: "tempo", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } }];
  assert.equal(executablePlan(raw, true).execute, true);
  assert.equal(executablePlan(raw, 1 as unknown as boolean).execute, false);

  const longArgs = { text: "x".repeat(2_100) };
  assert.equal(executablePlan([{ ...raw[0], args: longArgs }], true).steps?.[0].args !== undefined, true);
  assert.equal(executablePlan([{ ...raw[0], args: longArgs }], false).steps?.[0].args, undefined);
});

test("executable normalization rejects more than twelve steps instead of truncating a write plan", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    id: `tempo-${i}`,
    description: `Tempo ${i}`,
    tool: "set_tempo",
    args: { bpm: 120 },
  }));
  assert.equal(executablePlan(many).steps, null);
});

test("preflight rejects missing or duplicate IDs, missing args, and unknown tools", () => {
  const cases: PlanStep[][] = [
    [{ ...step("", { bpm: 128 }), id: "" }],
    [step("same", { bpm: 128 }), step("same", { bpm: 130 })],
    [{ id: "no-args", description: "No arguments", tool: "set_tempo", expectedEffects: [] }],
    [step("unknown", { bpm: 128 }, "search_samples")],
  ];
  for (const candidate of cases) {
    const result = preflightExecutablePlan(candidate, schemas, allowedTools);
    assert.equal(result.ok, false);
  }
});

test("preflight checks static arguments against tool input schemas", () => {
  const missingRequired = preflightExecutablePlan([step("tempo", {})], schemas, allowedTools);
  const wrongType = preflightExecutablePlan([step("tempo", { bpm: "fast" })], schemas, allowedTools);
  const extraProperty = preflightExecutablePlan([step("tempo", { bpm: 128, surprise: true })], schemas, allowedTools);
  assert.equal(missingRequired.ok, false);
  assert.equal(wrongType.ok, false);
  assert.equal(extraProperty.ok, false);
  assert.deepEqual(preflightExecutablePlan([step("tempo", { bpm: 128 })], schemas, allowedTools), { ok: true });
});

test("preflight validates total plan size, malformed pointers, and backward-only references", () => {
  const totalSize = preflightExecutablePlan([
    step("large-a", { bpm: "x".repeat(50_000) }),
    step("large-b", { bpm: "x".repeat(50_000) }),
  ], schemas, allowedTools);
  assert.equal(totalSize.ok, false);

  const forward = preflightExecutablePlan([
    step("first", { bpm: { $ref: "later#/bpm" } }),
    step("later", { bpm: 128 }),
  ], schemas, allowedTools);
  const missing = preflightExecutablePlan([
    step("first", { bpm: { $ref: "absent#/bpm" } }),
  ], schemas, allowedTools);
  const malformed = preflightExecutablePlan([
    step("first", { bpm: { $ref: "first#/bad~2escape" } }),
  ], schemas, allowedTools);
  assert.equal(forward.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(malformed.ok, false);
});

test("preflight rejects references nested under an untyped array schema before any writes", () => {
  const looseArraySchema: InputSchema = {
    type: "object",
    properties: {
      bpm: { type: "number" },
      tags: { type: "array" },
    },
    required: ["bpm"],
    additionalProperties: false,
  };
  const result = preflightExecutablePlan([
    step("source", { bpm: 128 }),
    step("target", { bpm: 120, tags: [{ $ref: "source#/bpm" }] }),
  ], new Map([["set_tempo", looseArraySchema]]), allowedTools);
  assert.equal(result.ok, false);
});

test("resolves escaped JSON Pointer segments, array indices, and checks consumer types", () => {
  const source = JSON.parse('{"a/b":{"tilde~key":[17]}}') as Record<string, unknown>;
  const schema: InputSchema = {
    type: "object",
    properties: { bpm: { type: "number" } },
    required: ["bpm"],
  };
  const good = resolvePlanReferences(
    { bpm: { $ref: "source#/a~1b/tilde~0key/0" } },
    schema,
    new Map([["source", source]]),
  );
  const wrongType = resolvePlanReferences(
    { bpm: { $ref: "source#/a~1b" } },
    schema,
    new Map([["source", source]]),
  );
  assert.deepEqual(good, { ok: true, value: { bpm: 17 } });
  assert.equal(wrongType.ok, false);
});

test("reference resolution uses own properties and never traverses inherited prototypes", () => {
  const normal = { track_index: 2 };
  const inherited = resolvePlanReferences(
    { bpm: { $ref: "source#/constructor/name" } },
    tempoSchema,
    new Map([["source", normal]]),
  );
  const missingOwn = resolvePlanReferences(
    { bpm: { $ref: "source#/__proto__/polluted" } },
    tempoSchema,
    new Map([["source", normal]]),
  );
  assert.equal(inherited.ok, false);
  assert.equal(missingOwn.ok, false);
});

test("sequential plan execution keeps results by ID and stops after errors, false execution, or a stop request", async () => {
  const successSteps = [step("a", { bpm: 120 }), step("b", { bpm: { $ref: "a#/bpm" } })];
  const seen: unknown[] = [];
  const success = await executePlanSequentially(
    successSteps,
    schemas,
    async (_planStep, args) => {
      seen.push(args);
      return { ok: true, result: { bpm: 128 } };
    },
    () => false,
  );
  assert.deepEqual(seen, [{ bpm: 120 }, { bpm: 128 }]);
  assert.deepEqual(success, {
    completedStepIds: ["a", "b"],
    skippedStepIds: [],
    stopped: false,
  });

  for (const failure of [
    { ok: false as const, result: { error: "denied" }, error: "denied" },
    { ok: false as const, result: { executed: false }, error: "not executed" },
  ]) {
    let calls = 0;
    const outcome = await executePlanSequentially(
      successSteps,
      schemas,
      async () => {
        calls++;
        return failure;
      },
      () => false,
    );
    assert.equal(calls, 1);
    assert.deepEqual(outcome.completedStepIds, []);
    assert.equal(outcome.failedStepId, "a");
    assert.deepEqual(outcome.skippedStepIds, ["b"]);
  }

  let stopCalls = 0;
  const stopped = await executePlanSequentially(
    successSteps,
    schemas,
    async () => {
      stopCalls++;
      return { ok: true, result: { bpm: 128 } };
    },
    () => stopCalls > 0,
  );
  assert.equal(stopCalls, 1);
  assert.deepEqual(stopped.completedStepIds, ["a"]);
  assert.deepEqual(stopped.skippedStepIds, ["b"]);
  assert.equal(stopped.stopped, true);

  const thrown = await executePlanSequentially(
    successSteps,
    schemas,
    async () => { throw new Error("bridge failed"); },
    () => false,
  );
  assert.deepEqual(thrown, {
    completedStepIds: [],
    failedStepId: "a",
    failure: "bridge failed",
    skippedStepIds: ["b"],
    stopped: false,
  });
});
