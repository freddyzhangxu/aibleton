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
  "insert_device", "replace_device", "delete_device", "set_device_parameter", "set_device_parameters",
  "set_track_mixer", "load_drum_kit", "import_audio_clip", "load_sample",
  "create_take_lane", "write_take_midi_clip", "import_take_audio_clip",
  "set_audio_clip_warp",
  "set_drum_pad_mixer", "insert_drum_pad_device", "duplicate_drum_pad_device", "delete_drum_pad_device", "replace_drum_pad_sample",
  "set_drum_pad_device_parameter", "set_drum_pad_device_parameters",
  "generate_audio", "write_midi_clip", "write_session_clip",
  "delete_arrangement_clip", "delete_session_clip", "set_clip_notes",
  "create_scene", "duplicate_scene", "delete_scene", "rename_scene",
  "create_cue_point", "rename_cue_point", "delete_cue_point",
]);

export interface ExplicitEditScope {
  /** Track names or all-track language stated in the current request. */
  trackIndices: number[];
  /** Explicitly named Arrangement bar ranges, represented as beat ranges. */
  arrangementRanges: { startBeat: number; endBeat: number }[];
}

function mentionIsNegated(text: string, start: number): boolean {
  const before = text.slice(0, start);
  const boundaries = [
    before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("."),
    before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"),
    before.lastIndexOf("，"), before.lastIndexOf("；"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"),
    ...[...before.matchAll(/\b(?:but|however)\b|但是|不过|但/giu)].map((match) => match.index ?? -1),
  ];
  const clause = before.slice(Math.max(...boundaries) + 1);
  return /\b(?:don't|do not|dont|never|avoid|leave|without|except(?:\s+for)?|excluding|but\s+not)\b|不要|别|不许|不(?:动|改|调整|修改|碰|删|清)|勿|除了|不包括|但不含/iu.test(clause);
}

/** Resolve only concrete track and bar scopes present in the current request. */
export function explicitEditScopeFor(context: Ctx, text: string): ExplicitEditScope {
  const trackIndices = new Set<number>();
  const excludesScope = /(?:\b(?:except|except\s+for|excluding|but\s+not)\b|除了|不包括|但不含)/iu.test(text);
  if (!excludesScope && /(?:\ball\s+tracks?\b|\bevery\s+track\b|\beach\s+track\b|\bacross\s+all\s+tracks\b|所有(?:轨道|音轨)|全部(?:轨道|音轨)|每条(?:轨道|音轨)|每个(?:轨道|音轨))/i.test(text)) {
    context.application.song.tracks.forEach((_track, index) => trackIndices.add(index));
  } else {
    const tracks = context.application.song.tracks;
    const nameCounts = new Map<string, number>();
    for (const track of tracks) {
      const key = track.name.trim().replace(/\s+/g, " ").toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const mentions: { index: number; start: number; end: number; length: number }[] = [];
    for (const [index, track] of tracks.entries()) {
      const name = track.name.trim();
      if (!name) continue;
      const key = name.replace(/\s+/g, " ").toLowerCase();
      if (nameCounts.get(key) !== 1) continue; // A name shared by tracks cannot identify one target.
      const escaped = name.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const pattern = /^[\p{L}\p{N}_ -]+$/u.test(name)
        ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu")
        : new RegExp(escaped, "iu");
      const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of text.matchAll(globalPattern)) {
        const start = match.index ?? 0;
        if (!mentionIsNegated(text, start)) mentions.push({ index, start, end: start + match[0].length, length: match[0].length });
      }
    }
    for (const mention of mentions) {
      const isPartOfLongerName = mentions.some((other) => other.index !== mention.index && other.length > mention.length &&
        other.start <= mention.start && other.end >= mention.end);
      if (!isPartOfLongerName) trackIndices.add(mention.index);
    }
  }
  // User-facing track ordinals are 1-based; translate them to tool indices.
  for (const match of text.matchAll(/\btrack\s+#?\s*(\d+)\b/gi)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < context.application.song.tracks.length) trackIndices.add(index);
  }
  for (const match of text.matchAll(/第\s*(\d+)\s*(?:号)?(?:轨道|音轨|轨)/gu)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < context.application.song.tracks.length) trackIndices.add(index);
  }

  const beatsPerBar = barBeats(context);
  const arrangementRanges: ExplicitEditScope["arrangementRanges"] = [];
  const addRange = (first: number, last: number) => {
    if (Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first) {
      arrangementRanges.push({ startBeat: (first - 1) * beatsPerBar, endBeat: last * beatsPerBar });
    }
  };
  for (const match of text.matchAll(/\b(?:bars?|measures?)\s*(\d+)\s*(?:-|–|to)\s*(\d+)\b/gi)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    addRange(Number(match[1]), Number(match[2]));
  }
  for (const match of text.matchAll(/\bbar\s*(\d+)\b/gi)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    addRange(Number(match[1]), Number(match[1]));
  }
  for (const match of text.matchAll(/(?:第\s*)?(\d+)\s*(?:-|–|到|至)\s*(\d+)\s*小节/gu)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    addRange(Number(match[1]), Number(match[2]));
  }
  for (const match of text.matchAll(/(?:第\s*)?(\d+)\s*小节/gu)) {
    if (mentionIsNegated(text, match.index ?? 0)) continue;
    addRange(Number(match[1]), Number(match[1]));
  }
  return { trackIndices: [...trackIndices], arrangementRanges };
}

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
  return `${what} 超出当前${selectionDescription(selection)}和本轮明确指定的轨道/小节范围。请在这些范围内操作；要越过它们，请明确要求整首歌或全局操作。`;
}

function checkTrack(selection: ResolvedSelection, trackIndex: number | null, scope: ExplicitEditScope): string | null {
  if (trackIndex === null) return null; // Dispatcher will report malformed tool input.
  const selected = selection.kind === "arrangement"
    ? selection.tracks.some((track) => track.index === trackIndex)
    : selection.slots.some((slot) => slot.trackIndex === trackIndex);
  const allowed = selected || scope.trackIndices.includes(trackIndex);
  return allowed ? null : failure(selection, `目标轨道 ${trackIndex}`);
}

function checkSessionSlot(
  selection: Extract<ResolvedSelection, { kind: "session" }>,
  trackIndex: number | null,
  sceneIndex: number | null,
  scope: ExplicitEditScope,
): string | null {
  if (trackIndex === null || sceneIndex === null) return null;
  return selection.slots.some((slot) => slot.trackIndex === trackIndex && slot.sceneIndex === sceneIndex) || scope.trackIndices.includes(trackIndex)
    ? null
    : failure(selection, `目标 Session 槽（轨道 ${trackIndex} / 场景 ${sceneIndex}）`);
}

function rangeIsExplicit(scope: ExplicitEditScope, start: number, end: number): boolean {
  return scope.arrangementRanges.some((range) => start >= range.startBeat - 1e-9 && end <= range.endBeat + 1e-9);
}

function checkArrangementRange(
  context: Ctx,
  selection: Extract<ResolvedSelection, { kind: "arrangement" }>,
  input: Record<string, unknown>,
  scope: ExplicitEditScope,
): string | null {
  const start = num(input.start_beat);
  if (start === null) return null;
  const length = num(input.length_beats) ?? num(input.duration_beats);
  if (length === null || length <= 0) return null;
  return isWithin(selection, start, start + length) || rangeIsExplicit(scope, start, start + length)
    ? null
    : failure(selection, `目标时间范围 beat ${start}–${start + length}`);
}

function checkExistingArrangementClip(
  context: Ctx,
  selection: Extract<ResolvedSelection, { kind: "arrangement" }>,
  trackIndex: number | null,
  input: Record<string, unknown>,
  scope: ExplicitEditScope,
): string | null {
  const trackError = checkTrack(selection, trackIndex, scope);
  if (trackError || trackIndex === null) return trackError;
  const clipIndex = num(input.clip_index);
  if (clipIndex === null || !Number.isInteger(clipIndex)) return null;
  const clip = context.application.song.tracks[trackIndex]?.arrangementClips[clipIndex];
  if (!clip) return null;
  const start = Number(clip.startTime);
  const end = Number(clip.endTime);
  return isWithin(selection, start, end) || scope.trackIndices.includes(trackIndex) || rangeIsExplicit(scope, start, end)
    ? null
    : failure(selection, `目标编排 Clip「${clip.name}」`);
}

function checkArrangeSong(
  context: Ctx,
  selection: ResolvedSelection,
  input: Record<string, unknown>,
  scope: ExplicitEditScope,
): string | null {
  const placements = Array.isArray(input.placements) ? input.placements : [];
  for (const placement of placements) {
    const spec = record(placement);
    if (!spec) continue;
    const trackError = checkTrack(selection, targetTrackIndex(context, spec), scope);
    if (trackError) return trackError;
    if (selection.kind === "arrangement") {
      const startBar = num(spec.start_bar);
      const lengthBars = num(spec.length_bars);
      if (startBar !== null && lengthBars !== null && lengthBars > 0) {
        const start = (startBar - 1) * barBeats(context);
        const end = start + lengthBars * barBeats(context);
        if (!isWithin(selection, start, end) && !rangeIsExplicit(scope, start, end)) return failure(selection, `placement 的时间范围 beat ${start}–${end}`);
      }
    }
  }
  if (selection.kind === "arrangement" && Array.isArray(input.clear_range_bars) && input.clear_range_bars.length === 2) {
    const first = num(input.clear_range_bars[0]);
    const last = num(input.clear_range_bars[1]);
    if (first !== null && last !== null && last >= first) {
      const start = (first - 1) * barBeats(context);
      const end = last * barBeats(context);
      if (!isWithin(selection, start, end) && !rangeIsExplicit(scope, start, end)) return failure(selection, `清除范围 beat ${start}–${end}`);
    }
  }
  return null;
}

/** Return an actionable error string when the call would leave the current
 * selection and explicit current-turn track/bar scope, otherwise null. Global
 * and named scopes are derived from this user turn, never chat history. */
export function selectionGuard(
  context: Ctx,
  selection: ResolvedSelection | null,
  globalIntent: boolean,
  name: string,
  input: Record<string, unknown>,
  scope: ExplicitEditScope = { trackIndices: [], arrangementRanges: [] },
): string | null {
  if (!selection || globalIntent || !MUTATING_TOOLS.has(name) || NO_COORDINATE_TOOLS.has(name)) return null;
  if (name === "arrange_song") return checkArrangeSong(context, selection, input, scope);

  if (name === "generate_audio") {
    const importTo = record(input.importTo);
    return importTo ? selectionGuard(context, selection, false, "import_audio_clip", importTo, scope) : null;
  }

  const trackIndex = targetTrackIndex(context, input);
  if (selection.kind === "session") {
    const sceneIndex = num(input.scene_index);
    if (sceneIndex !== null) return checkSessionSlot(selection, trackIndex, sceneIndex, scope);
    return checkTrack(selection, trackIndex, scope);
  }

  // Arrangement selection: first ensure the target track belongs to the
  // selected lanes, then check direct timeline operations when coordinates
  // are available.
  if (["get_clip_notes", "set_clip_notes", "delete_arrangement_clip", "set_audio_clip_warp"].includes(name)) {
    return checkExistingArrangementClip(context, selection, trackIndex, input, scope);
  }
  const trackError = checkTrack(selection, trackIndex, scope);
  if (trackError) return trackError;
  if (["write_midi_clip", "import_audio_clip", "write_take_midi_clip", "import_take_audio_clip"].includes(name) && input.scene_index === undefined) {
    return checkArrangementRange(context, selection, input, scope);
  }
  return null;
}
