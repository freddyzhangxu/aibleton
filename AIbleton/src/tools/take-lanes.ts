import { AudioClip, MidiClip, type TakeLane, type Track } from "@ableton-extensions/sdk";
import { toNum } from "./helpers.js";

/** Resolve a Take Lane with a helpful, stable zero-based error. */
export function takeLaneAt(track: Track<"1.0.0">, index: unknown): TakeLane<"1.0.0"> {
  const laneIndex = Number(index);
  const lanes = track.takeLanes;
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex >= lanes.length) {
    throw new Error(`Take Lane 序号 ${String(index)} 无效；轨道「${track.name}」共有 ${lanes.length} 条 Take Lane（0 起计）`);
  }
  return lanes[laneIndex];
}

/** Compact, honest lane presentation. A lane is a candidate container, not a
 * guarantee that Live is currently auditioning it. */
export function presentTakeLanes(track: Track<"1.0.0">): Array<Record<string, unknown>> {
  return track.takeLanes.map((lane, index) => ({
    index,
    name: lane.name,
    clips: lane.clips.map((clip, clipIndex) => ({
      index: clipIndex,
      name: clip.name,
      type: clip instanceof MidiClip ? "MIDI" : clip instanceof AudioClip ? "Audio" : "Clip",
      start_beat: toNum(clip.startTime),
      length_beats: toNum(clip.duration),
    })),
  }));
}
