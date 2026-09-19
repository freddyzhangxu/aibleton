import assert from "node:assert/strict";
import test from "node:test";
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
