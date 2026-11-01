import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, resetTurnState } from "./runtime.js";
import { answerConfirmation, getPendingConfirm } from "../chat/gates.js";
import { runTool } from "../tools/dispatcher.js";
import { toolHooks, toolState, type Ctx } from "../state.js";
import type { ToolAction } from "../chat/receipt.js";
import { audioGenerationAuthorized } from "../chat/audioauth.js";

test("a speculative generate_audio call is refused before paid confirmation, even in YOLO", async () => {
  resetTurnState();
  toolState.activeAudioGenerationAuthorized = audioGenerationAuthorized("制作一首布鲁斯");
  const debugLog = toolHooks.debugLog;
  const getAudioAutoRefine = toolHooks.getAudioAutoRefine;
  toolHooks.debugLog = () => {};
  toolHooks.getAudioAutoRefine = () => false;
  const context = { application: { song: { tracks: [] } } } as unknown as Ctx;
  const actions: ToolAction[] = [];
  try {
    const pending = callTool(context, actions, "generate_audio", { prompt: "A blues song" }, true);
    const confirmation = getPendingConfirm();
    // Clean up even when the regression opens the unwanted paid dialog.
    answerConfirmation(false);
    const result = JSON.parse(await pending);
    assert.equal(confirmation, null);
    assert.equal(result.executed, false);
    assert.equal(result.code, "audio_generation_not_requested");
    assert.equal(actions.length, 1);
    assert.equal(toolState.progress.completedTools, 0);
  } finally {
    answerConfirmation(false);
    toolHooks.debugLog = debugLog;
    toolHooks.getAudioAutoRefine = getAudioAutoRefine;
    resetTurnState();
  }
});

test("explicitly requested generation still uses the existing paid confirmation", async () => {
  resetTurnState();
  const debugLog = toolHooks.debugLog;
  const getAudioAutoRefine = toolHooks.getAudioAutoRefine;
  toolHooks.debugLog = () => {};
  toolHooks.getAudioAutoRefine = () => false;
  toolState.activeAudioGenerationAuthorized = audioGenerationAuthorized("用AI生成一首布鲁斯");
  try {
    const context = { application: { song: { tracks: [] } } } as unknown as Ctx;
    const pending = callTool(context, [], "generate_audio", { prompt: "A blues song" }, true);
    const confirmation = getPendingConfirm();
    answerConfirmation(false);
    const result = JSON.parse(await pending);
    assert.equal(confirmation?.tool, "generate_audio");
    assert.notEqual(result.code, "audio_generation_not_requested");
  } finally {
    answerConfirmation(false);
    toolState.activeAudioGenerationAuthorized = false;
    toolHooks.debugLog = debugLog;
    toolHooks.getAudioAutoRefine = getAudioAutoRefine;
    resetTurnState();
  }
});

test("direct dispatch cannot bypass the audio generation intent boundary", async () => {
  const context = { application: { song: {} } } as Ctx;
  const result = await runTool(context, "generate_audio", { prompt: "A blues song" })
    .catch((error: Error) => ({ error: error.message })) as Record<string, unknown>;
  assert.equal(result.executed, false);
  assert.equal(result.code, "audio_generation_not_requested");
});
