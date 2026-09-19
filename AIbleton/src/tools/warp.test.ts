import assert from "node:assert/strict";
import test from "node:test";
import { AudioClip, MidiClip, WarpMode } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";
import { parseWarpMode, resolveAudioClip } from "./warp.js";

function audioClip(name = "Vocal"): AudioClip<"1.0.0"> {
  const clip = Object.create(AudioClip.prototype) as AudioClip<"1.0.0">;
  Object.defineProperties(clip, {
    name: { value: name, writable: true, configurable: true },
    warping: { value: false, writable: true, configurable: true },
    warpMode: { value: WarpMode.Beats, writable: true, configurable: true },
    warpMarkers: { value: [{ sampleTime: 44100, beatTime: 4 }], configurable: true },
    startTime: { value: 8, configurable: true },
    endTime: { value: 12, configurable: true },
  });
  return clip;
}

function contextFor(clip: unknown, session = false): Ctx {
  const track = {
    name: "Vocal",
    arrangementClips: session ? [] : [clip],
    clipSlots: session ? [{ clip }] : [],
    takeLanes: [],
  };
  return { application: { song: { tracks: [track], scenes: [{}] } } } as unknown as Ctx;
}

test("reads arrangement warp state and maps mode strings", async () => {
  const clip = audioClip();
  const out = await runTool(contextFor(clip), "get_audio_clip_warp", { track_index: 0, clip_index: 0 }) as Record<string, unknown>;
  assert.equal(out.warped, false);
  assert.equal(out.warp_mode, "beats");
  assert.deepEqual(out.warp_markers, [{ sample_time: 44100, beat_time: 4 }]);
  assert.equal(parseWarpMode("Complex Pro"), WarpMode.ComplexPro);
  assert.throws(() => parseWarpMode("elastic"), /warp_mode 无效/);
});

test("sets a mode by enabling warping first and can explicitly turn it off", async () => {
  const clip = audioClip();
  const context = contextFor(clip);
  const changed = await runTool(context, "set_audio_clip_warp", {
    track_index: 0, clip_index: 0, warp_mode: "complex_pro",
  }) as Record<string, unknown>;
  assert.equal(clip.warping, true);
  assert.equal(clip.warpMode, WarpMode.ComplexPro);
  assert.equal(changed.warp_mode, "complex_pro");
  await runTool(context, "set_audio_clip_warp", { track_index: 0, clip_index: 0, warped: false });
  assert.equal(clip.warping, false);
  await assert.rejects(() => runTool(context, "set_audio_clip_warp", {
    track_index: 0, clip_index: 0, warped: false, warp_mode: "tones",
  }), /不能同时将 warped 设为 false/);
});

test("resolves a Session audio clip and rejects MIDI or ambiguous targets", () => {
  const sessionClip = audioClip("Session vocal");
  const session = resolveAudioClip(contextFor(sessionClip, true), { track_index: 0, scene_index: 0 });
  assert.deepEqual(session.location, { scene_index: 0 });
  const midi = Object.create(MidiClip.prototype);
  assert.throws(() => resolveAudioClip(contextFor(midi), { track_index: 0, clip_index: 0 }), /不是 Audio Clip/);
  assert.throws(() => resolveAudioClip(contextFor(audioClip()), { track_index: 0, clip_index: 0, scene_index: 0 }), /请且只提供/);
});
