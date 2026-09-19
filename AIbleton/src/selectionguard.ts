import type { Ctx } from "./state.js";
import type { ResolvedSelection } from "./setcontext.js";

/**
 * Tool-side enforcement for the transient Live selection. Prompt context tells
 * the agent what the user selected; this module makes an accidental mutation
 * outside that selection fail before the dispatcher touches Live.
 */

const NO_COORDINATE_TOOLS = new Set([
  "set_goal", "set_plan", "update_memory", "set_tempo",
  "create_midi_track", "create_audio_track", "create_move_track",
  "create_scene", "duplicate_scene", "delete_scene", "rename_scene",
  "create_cue_point", "rename_cue_point", "delete_cue_point",
  "move_pair", "move_upload_sample", "move_download_set", "move_analyze_set",
  "generate_audio", "web_search", "web_fetch",
]);

/** Keep read-only inspection available outside a selected region. The runtime
 * already has its own READ_ONLY_TOOLS policy; this mirror lets runTool retain
 * the same behavior when called directly. */
const MUTATING_TOOLS = new Set([
  "arrange_song", "update_memory", "set_tempo", "create_midi_track",
  "create_audio_track", "duplicate_track", "delete_track", "create_move_track",
  "move_pair", "move_upload_sample", "rename_track", "set_track_state",
  "insert_device", "delete_device", "set_device_parameter", "set_device_parameters",
  "set_track_mixer", "load_drum_kit", "import_audio_clip", "load_sample",
  "create_take_lane", "write_take_midi_clip", "import_take_audio_clip",
  "set_audio_clip_warp",
  "set_drum_pad_mixer", "insert_drum_pad_device", "duplicate_drum_pad_device",
  "generate_audio", "write_midi_clip", "write_session_clip",
  "delete_arrangement_clip", "delete_session_clip", "set_clip_notes",
  "create_scene", "duplicate_scene", "delete_scene", "rename_scene",
  "create_cue_point", "rename_cue_point", "delete_cue_point",
]);

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function targetTrackIndex(context: Ctx, input: Record<string, unknown>): number | null {
  for (const key of ["track_index", "index"] as const) {
    const n = num(input[key]);
    if (n !== null && Number.isInteger(n)) return n;
  }
  const name = typeof input.track_name === "string" ? input.track_name.trim().toLowerCase() : "";
  if (!name) return null;
  const matches = context.application.song.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.name.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0].index : null;
}

function barBeats(context: Ctx): number {
  const scene = context.application.song.scenes[0];
  const numerator = Number(scene?.signatureNumerator) || 4;
  const denominator = Number(scene?.signatureDenominator) || 4;
  return numerator * 4 / denominator;
}

function isWithin(selection: Extract<ResolvedSelection, { kind: "arrangement" }>, start: number, end: number): boolean {
  return start >= selection.startBeat - 1e-9 && end <= selection.endBeat + 1e-9;
}

function selectionDescription(selection: ResolvedSelection): string {
  if (selection.kind === "arrangement") {
    return `编排选区：轨道 ${selection.tracks.map((t) => `${t.index}「${t.name}」`).join("、")}，beat ${selection.startBeat}–${selection.endBeat}`;
  }
  return `Session 选区：${selection.slots.map((s) => `轨道 ${s.trackIndex}「${s.trackName}」/ 场景 ${s.sceneIndex}`).join("、")}`;
}

function failure(selection: ResolvedSelection, what: string): string {
  return `${what} 超出当前${selectionDescription(selection)}。请在选区内操作；只有用户在本轮明确要求“整首歌/全局/whole song”时才能越界。`;
}

function checkTrack(selection: ResolvedSelection, trackIndex: number | null): string | null {
  if (trackIndex === null) return null; // Dispatcher will report malformed tool input.
  const allowed = selection.kind === "arrangement"
    ? selection.tracks.some((track) => track.index === trackIndex)
    : selection.slots.some((slot) => slot.trackIndex === trackIndex);
  return allowed ? null : failure(selection, `目标轨道 ${trackIndex}`);
}

function checkSessionSlot(
  selection: Extract<ResolvedSelection, { kind: "session" }>,
  trackIndex: number | null,
  sceneIndex: number | null,
): string | null {
  if (trackIndex === null || sceneIndex === null) return null;
  return selection.slots.some((slot) => slot.trackIndex === trackIndex && slot.sceneIndex === sceneIndex)
    ? null
    : failure(selection, `目标 Session 槽（轨道 ${trackIndex} / 场景 ${sceneIndex}）`);
}

function checkArrangementRange(
  context: Ctx,
  selection: Extract<ResolvedSelection, { kind: "arrangement" }>,
  input: Record<string, unknown>,
): string | null {
  const start = num(input.start_beat);
  if (start === null) return null;
  const length = num(input.length_beats) ?? num(input.duration_beats);
  if (length === null || length <= 0) return null;
  return isWithin(selection, start, start + length) ? null : failure(selection, `目标时间范围 beat ${start}–${start + length}`);
}

function checkExistingArrangementClip(
  context: Ctx,
  selection: Extract<ResolvedSelection, { kind: "arrangement" }>,
  trackIndex: number | null,
  input: Record<string, unknown>,
): string | null {
  const trackError = checkTrack(selection, trackIndex);
  if (trackError || trackIndex === null) return trackError;
  const clipIndex = num(input.clip_index);
  if (clipIndex === null || !Number.isInteger(clipIndex)) return null;
  const clip = context.application.song.tracks[trackIndex]?.arrangementClips[clipIndex];
  if (!clip) return null;
  return isWithin(selection, Number(clip.startTime), Number(clip.endTime))
    ? null
    : failure(selection, `目标编排 Clip「${clip.name}」`);
}

function checkArrangeSong(
  context: Ctx,
  selection: ResolvedSelection,
  input: Record<string, unknown>,
): string | null {
  const placements = Array.isArray(input.placements) ? input.placements : [];
  for (const placement of placements) {
    const spec = record(placement);
    if (!spec) continue;
    const trackError = checkTrack(selection, targetTrackIndex(context, spec));
    if (trackError) return trackError;
    if (selection.kind === "arrangement") {
      const startBar = num(spec.start_bar);
      const lengthBars = num(spec.length_bars);
      if (startBar !== null && lengthBars !== null && lengthBars > 0) {
        const start = (startBar - 1) * barBeats(context);
        const end = start + lengthBars * barBeats(context);
        if (!isWithin(selection, start, end)) return failure(selection, `placement 的时间范围 beat ${start}–${end}`);
      }
    }
  }
  if (selection.kind === "arrangement" && Array.isArray(input.clear_range_bars) && input.clear_range_bars.length === 2) {
    const first = num(input.clear_range_bars[0]);
    const last = num(input.clear_range_bars[1]);
    if (first !== null && last !== null && last >= first) {
      const start = (first - 1) * barBeats(context);
      const end = last * barBeats(context);
      if (!isWithin(selection, start, end)) return failure(selection, `清除范围 beat ${start}–${end}`);
    }
  }
  return null;
}

/** Return an actionable error string when the call would leave the current
 * selection, otherwise null. `globalIntent` is derived only from this user
 * turn, never from earlier chat history. */
export function selectionGuard(
  context: Ctx,
  selection: ResolvedSelection | null,
  globalIntent: boolean,
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (!selection || globalIntent || !MUTATING_TOOLS.has(name) || NO_COORDINATE_TOOLS.has(name)) return null;
  if (name === "arrange_song") return checkArrangeSong(context, selection, input);

  if (name === "generate_audio") {
    const importTo = record(input.importTo);
    return importTo ? selectionGuard(context, selection, false, "import_audio_clip", importTo) : null;
  }

  const trackIndex = targetTrackIndex(context, input);
  if (selection.kind === "session") {
    const sceneIndex = num(input.scene_index);
    if (sceneIndex !== null) return checkSessionSlot(selection, trackIndex, sceneIndex);
    return checkTrack(selection, trackIndex);
  }

  // Arrangement selection: first ensure the target track belongs to the
  // selected lanes, then check direct timeline operations when coordinates
  // are available.
  if (["get_clip_notes", "set_clip_notes", "delete_arrangement_clip", "set_audio_clip_warp"].includes(name)) {
    return checkExistingArrangementClip(context, selection, trackIndex, input);
  }
  const trackError = checkTrack(selection, trackIndex);
  if (trackError) return trackError;
  if (["write_midi_clip", "import_audio_clip", "write_take_midi_clip", "import_take_audio_clip"].includes(name) && input.scene_index === undefined) {
    return checkArrangementRange(context, selection, input);
  }
  return null;
}
