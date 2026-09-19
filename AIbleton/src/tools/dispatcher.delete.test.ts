import assert from "node:assert/strict";
import test from "node:test";
import { DrumRack } from "@ableton-extensions/sdk";
import { deleteAuthorizationFor } from "../chat/deleteauth.js";
import { toolState, type Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

function contextWithDeleteSpies() {
  const calls: string[] = [];
  const device = { name: "EQ Eight" };
  const arrangementClip = { name: "Old loop" };
  const sessionClip = { name: "Old scene loop" };
  const slot = {
    clip: sessionClip,
    deleteClip: async () => { calls.push("session_clip"); },
  };
  const track = {
    name: "Bass",
    devices: [device],
    arrangementClips: [arrangementClip],
    clipSlots: [slot],
    deleteDevice: async (d: unknown) => { assert.equal(d, device); calls.push("device"); },
    deleteClip: async (c: unknown) => { assert.equal(c, arrangementClip); calls.push("arrangement_clip"); },
  };
  const scene = { name: "Verse" };
  const song = {
    tracks: [track],
    scenes: [scene],
    deleteTrack: async (t: unknown) => { assert.equal(t, track); calls.push("track"); },
    deleteScene: async (s: unknown) => { assert.equal(s, scene); calls.push("scene"); },
  };
  const context = {
    application: { song },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, calls };
}

test("delete tools call their matching SDK operation with current targets", async () => {
  const { context, calls } = contextWithDeleteSpies();
  toolState.activeDeleteAuthorization = deleteAuthorizationFor(
    "删除轨道、场景、设备、编排区片段和会话片段",
  );
  try {
    await runTool(context, "delete_track", { track_index: 0, track_name: "Bass" });
    await runTool(context, "delete_scene", { scene_index: 0 });
    await runTool(context, "delete_device", { track_index: 0, track_name: "Bass", device_index: 0 });
    await runTool(context, "delete_arrangement_clip", { track_index: 0, track_name: "Bass", clip_index: 0 });
    await runTool(context, "delete_session_clip", { track_index: 0, track_name: "Bass", scene_index: 0 });
    assert.deepEqual(calls, ["track", "scene", "device", "arrangement_clip", "session_clip"]);
  } finally {
    toolState.activeDeleteAuthorization = undefined;
  }
});

test("dispatcher rejects unapproved deletion before resolving a target", async () => {
  toolState.activeDeleteAuthorization = undefined;
  const context = {
    application: {
      song: {
        get tracks() { throw new Error("must not resolve a target"); },
      },
    },
  } as unknown as Ctx;
  const result = await runTool(context, "delete_track", { track_index: 0 });
  assert.equal((result as { delete_authorization_required?: boolean }).delete_authorization_required, true);
  assert.match((result as { error: string }).error, /删除未执行/);
});

test("delete_drum_pad_device deletes the resolved chain device under device authorization", async () => {
  const calls: string[] = [];
  const padDevice = { name: "Reverb" };
  const chain = {
    receivingNote: 38,
    devices: [padDevice],
    deleteDevice: async (device: unknown) => { assert.equal(device, padDevice); calls.push("pad_device"); },
  };
  const rack = Object.create(DrumRack.prototype) as DrumRack<"1.0.0">;
  Object.defineProperties(rack, {
    name: { value: "Kit", configurable: true },
    chains: { value: [chain], configurable: true },
  });
  const track = { name: "Drums", devices: [rack] };
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  toolState.activeDeleteAuthorization = deleteAuthorizationFor("删除这个设备");
  try {
    const result = await runTool(context, "delete_drum_pad_device", { track_index: 0, pad_note: 38, device_index: 0 });
    assert.deepEqual(calls, ["pad_device"]);
    assert.deepEqual(result, {
      deleted: "drum_pad_device", device: "Reverb", device_index: 0, rack: "Kit", pad_note: 38,
      undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。", track_index: 0,
    });
  } finally {
    toolState.activeDeleteAuthorization = undefined;
  }
});

test("duplicate_drum_pad_device resolves pad_note before duplicating", async () => {
  const padDevice = { name: "Reverb" };
  const chain = {
    receivingNote: 38,
    devices: [padDevice],
    duplicateDevice: async (device: unknown) => { assert.equal(device, padDevice); return { name: "Reverb 2" }; },
    mixer: { volume: { getValue: async () => 0 }, panning: { getValue: async () => 0 }, sends: [] },
  };
  const rack = Object.create(DrumRack.prototype) as DrumRack<"1.0.0">;
  Object.defineProperties(rack, {
    name: { value: "Kit", configurable: true },
    chains: { value: [chain], configurable: true },
  });
  const context = {
    application: { song: { tracks: [{ name: "Drums", devices: [rack] }], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  const result = await runTool(context, "duplicate_drum_pad_device", { track_index: 0, pad_note: 38, device_index: 0 });
  assert.equal((result as { created: string }).created, "Reverb 2");
});
