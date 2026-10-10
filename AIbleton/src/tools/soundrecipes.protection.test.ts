import assert from "node:assert/strict";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import { deleteAuthorizationFor } from "../chat/deleteauth.js";
import { clearSelectionContext } from "../setcontext.js";
import { toolState, type Ctx } from "../state.js";
import { applySoundRecipe } from "./soundrecipes.js";

function midiContext(initialDevices: { name: string; parameters: never[] }[] = []) {
  const devices = [...initialDevices];
  const calls: string[] = [];
  const track = Object.create(MidiTrack.prototype);
  Object.defineProperties(track, {
    name: { value: "Lead", writable: true },
    devices: { get: () => devices },
  });
  track.deleteDevice = async (device: { name: string; parameters: never[] }) => {
    calls.push(`delete:${device.name}`);
    const index = devices.indexOf(device);
    if (index >= 0) devices.splice(index, 1);
  };
  track.insertDevice = async (name: string, index: number) => {
    calls.push(`insert:${name}`);
    const device = { name, parameters: [] as never[] };
    devices.splice(index, 0, device);
    return device;
  };
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, devices, calls };
}

async function withRecipeState<T>(
  fn: () => Promise<T>,
  options: { userText?: string; trackIndices?: number[]; yolo?: boolean } = {},
): Promise<T> {
  const previous = {
    scope: toolState.activeExplicitEditScope,
    globalIntent: toolState.activeGlobalIntent,
    yolo: toolState.activeYolo,
    authorization: toolState.activeDeleteAuthorization,
    createdTracks: [...toolState.activeCreatedTrackHandles],
  };
  clearSelectionContext();
  toolState.activeCreatedTrackHandles.clear();
  toolState.activeExplicitEditScope = { trackIndices: options.trackIndices ?? [], arrangementRanges: [] };
  toolState.activeGlobalIntent = false;
  toolState.activeYolo = options.yolo ?? true;
  toolState.activeDeleteAuthorization = deleteAuthorizationFor(options.userText ?? "Design an airy Pad sound.");
  try {
    return await fn();
  } finally {
    toolState.activeExplicitEditScope = previous.scope;
    toolState.activeGlobalIntent = previous.globalIntent;
    toolState.activeYolo = previous.yolo;
    toolState.activeDeleteAuthorization = previous.authorization;
    toolState.activeCreatedTrackHandles.clear();
    for (const id of previous.createdTracks) toolState.activeCreatedTrackHandles.add(id);
    clearSelectionContext();
  }
}

test("a new sound design cannot replace an existing instrument even when YOLO is enabled", async () => {
  const source = { name: "Operator", parameters: [] as never[] };
  const { context, devices, calls } = midiContext([source]);

  const result = await withRecipeState(() => applySoundRecipe(context, {
    track_index: 0,
    track_name: "Lead",
    recipe_id: "pad_airy",
  }));

  assert.equal(result.executed, false);
  assert.equal(result.requires_new_track, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(devices, [source]);
});

test("an explicit source replacement request can still change the named track", async () => {
  const source = { name: "Operator", parameters: [] as never[] };
  const { context, devices, calls } = midiContext([source]);
  const result = await withRecipeState(() => applySoundRecipe(context, {
    track_index: 0,
    track_name: "Lead",
    recipe_id: "pad_airy",
  }), {
    userText: "Replace the Operator source on Lead with an airy Pad sound.",
    trackIndices: [0],
    yolo: false,
  });

  assert.equal(result.executed, undefined);
  assert.deepEqual(calls, ["delete:Operator", "insert:Wavetable"]);
  assert.deepEqual(devices.map((device) => device.name), ["Wavetable"]);
});
