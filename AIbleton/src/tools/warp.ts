import { AudioClip, WarpMode } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { resolveTrack, trackResult, type TrackRef } from "./helpers.js";

const MODE_BY_NAME: Record<string, WarpMode> = {
  beats: WarpMode.Beats,
  tones: WarpMode.Tones,
  texture: WarpMode.Texture,
  repitch: WarpMode.Repitch,
  complex: WarpMode.Complex,
  complex_pro: WarpMode.ComplexPro,
};

const NAME_BY_MODE: Record<number, string> = Object.fromEntries(
  Object.entries(MODE_BY_NAME).map(([name, mode]) => [mode, name]),
);

export type ResolvedAudioClip = {
  ref: TrackRef;
  clip: AudioClip<"1.0.0">;
  location: { arrangement_clip_index: number } | { scene_index: number };
};

/** Resolve exactly one existing Audio Clip in arrangement or Session View. */
export function resolveAudioClip(context: Ctx, input: Record<string, unknown>): ResolvedAudioClip {
  const ref = resolveTrack(context, input, "track_index");
  const hasArrangement = typeof input.clip_index === "number";
  const hasSession = typeof input.scene_index === "number";
  if (hasArrangement === hasSession) {
    throw new Error("请且只提供 clip_index（编排区）或 scene_index（Session 槽）");
  }
  let candidate: unknown;
  let location: ResolvedAudioClip["location"];
  if (hasArrangement) {
    const index = Number(input.clip_index);
    if (!Number.isInteger(index) || index < 0) throw new Error("clip_index 必须是非负整数");
    candidate = ref.track.arrangementClips[index];
    if (!candidate) throw new Error(`编排区 Clip 序号 ${index} 无效`);
    location = { arrangement_clip_index: index };
  } else {
    const index = Number(input.scene_index);
    if (!Number.isInteger(index) || index < 0) throw new Error("scene_index 必须是非负整数");
    const slot = ref.track.clipSlots[index];
    if (!slot) throw new Error(`Session 场景序号 ${index} 无效`);
    candidate = slot.clip;
    if (!candidate) throw new Error(`轨道 ${ref.index}（${ref.track.name}）的 Session 槽 ${index} 为空`);
    location = { scene_index: index };
  }
  if (!(candidate instanceof AudioClip)) throw new Error("目标 Clip 不是 Audio Clip，不能编辑 Warp");
  return { ref, clip: candidate, location };
}

export function parseWarpMode(value: unknown): WarpMode {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
  const mode = MODE_BY_NAME[normalized];
  if (mode === undefined) {
    throw new Error("warp_mode 无效；可选：beats、tones、texture、repitch、complex、complex_pro");
  }
  return mode;
}

export function presentWarp(resolved: ResolvedAudioClip): Record<string, unknown> {
  const { ref, clip, location } = resolved;
  const mode = NAME_BY_MODE[Number(clip.warpMode)] ?? `unknown:${String(clip.warpMode)}`;
  return trackResult(ref, {
    track: ref.track.name,
    clip: clip.name,
    ...location,
    warped: clip.warping,
    warp_mode: mode,
    warp_markers: clip.warpMarkers.map((marker) => ({
      sample_time: marker.sampleTime,
      beat_time: marker.beatTime,
    })),
  });
}
