import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { resetTurnState, callTool, goalGate } from "./runtime.js";
import { toolHooks, toolState, type Ctx } from "../state.js";
import type { ToolAction } from "../chat/receipt.js";

function fixture() {
  const song = {
    tempo: 120,
    scaleMode: false,
    rootNote: 0,
    scaleName: "C Major",
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }],
    tracks: [] as unknown[],
    returnTracks: [],
    cuePoints: [],
  };
  const context = {
    application: { song },
    withinTransaction: <T>(fn: () => T): T => fn(),
  } as unknown as Ctx;
  const actions: ToolAction[] = [];
  return { song, context, actions };
}

const originalDebugLog = toolHooks.debugLog;

afterEach(() => {
  resetTurnState();
  toolHooks.debugLog = originalDebugLog;
  toolState.stopRequested = false;
  toolState.stopReason = null;
  toolState.activeGlobalIntent = false;
  toolState.activeExplicitEditScope = { trackIndices: [], arrangementRanges: [] };
});

async function declareTempoGoal(context: Ctx, actions: ToolAction[]): Promise<void> {
  toolHooks.debugLog = () => {};
  await callTool(context, actions, "set_goal", {
    type: "edit",
    objective: "Keep the tempo within the requested plan",
    successCriteria: [{ kind: "tempo_unchanged" }],
  }, true);
}

test("one opted-in set_plan call executes ordered steps and resolves earlier results", async () => {
  const { song, context, actions } = fixture();
  await declareTempoGoal(context, actions);

  const resultJson = await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "tempo-a", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "tempo-b", description: "Reapply returned tempo", tool: "set_tempo", args: { bpm: { $ref: "tempo-a#/tempo" } } },
    ],
  }, true);

  const result = JSON.parse(resultJson) as { execution?: { completed_step_ids?: string[] } };
  assert.deepEqual(result.execution?.completed_step_ids, ["tempo-a", "tempo-b"]);
  assert.equal(song.tempo, 128);
  assert.deepEqual(actions.map((action) => action.tool), [
    "set_goal", "set_plan", "set_tempo", "set_tempo",
  ]);
});

test("an executable plan that fails preflight leaves the Live Set unchanged", async () => {
  const { song, context, actions } = fixture();
  await declareTempoGoal(context, actions);

  const resultJson = await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "same", description: "First tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "same", description: "Second tempo", tool: "set_tempo", args: { bpm: 140 } },
    ],
  }, true);

  const result = JSON.parse(resultJson) as { error?: string };
  assert.equal(typeof result.error, "string");
  assert.equal(song.tempo, 120);
  assert.deepEqual(actions.map((action) => action.tool), ["set_goal", "set_plan"]);
});

test("fully specified edits execute without inventing a musical goal", async () => {
  resetTurnState();
  toolHooks.debugLog = () => {};
  const { song, context, actions } = fixture();
  const result = JSON.parse(await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "first", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "second", description: "Use returned tempo", tool: "set_tempo", args: { bpm: { $ref: "first#/tempo" } } },
    ],
  }, true));
  assert.equal(song.tempo, 128);
  assert.equal(result.execution.status, "completed");
  assert.deepEqual(result.execution.completed_step_ids, ["first", "second"]);
  assert.equal(await goalGate(context, "en"), null);
});

test("a goal-free batch stops after a denied delete and leaves later steps uncalled", async () => {
  resetTurnState();
  toolHooks.debugLog = () => {};
  const { song, context, actions } = fixture();
  const result = JSON.parse(await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "first", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "delete", description: "Delete track", tool: "delete_track", args: { track_index: 0 } },
      { id: "last", description: "Change tempo again", tool: "set_tempo", args: { bpm: 140 } },
    ],
  }, true));
  assert.equal(song.tempo, 128);
  assert.equal(result.execution.status, "partial");
  assert.equal(result.execution.failed_step_id, "delete");
  assert.deepEqual(result.execution.skipped_step_ids, ["last"]);
});

test("executable normalization never silently drops malformed steps before writing", async () => {
  const { song, context, actions } = fixture();
  await declareTempoGoal(context, actions);
  const result = JSON.parse(await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "valid", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "invalid", tool: "set_tempo", args: { bpm: 140 } },
    ],
  }, true));
  assert.equal(typeof result.error, "string");
  assert.equal(song.tempo, 120);
});

test("batch progress counts completed operations and times each internal step", async () => {
  resetTurnState();
  const lines: string[] = [];
  toolHooks.debugLog = (_ctx, line) => { lines.push(line); };
  const { context, actions } = fixture();
  await callTool(context, actions, "set_plan", {
    execute: true,
    steps: [
      { id: "first", description: "Set tempo", tool: "set_tempo", args: { bpm: 128 } },
      { id: "second", description: "Set tempo again", tool: "set_tempo", args: { bpm: 130 } },
    ],
  }, true);
  assert.equal(toolState.progress?.completedTools, 2);
  for (const id of ["first", "second"]) assert.ok(lines.some((line) => line.startsWith(`TIMING PLAN_STEP id=${id} tool=set_tempo `)));
  resetTurnState();
  assert.equal(toolState.progress?.completedTools, 0);
});
