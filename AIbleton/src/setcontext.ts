import {
  AudioClip,
  AudioTrack,
  Clip,
  ClipSlot,
  DataModelObject,
  MidiClip,
  MidiTrack,
  Scene,
  TakeLane,
  type Handle,
  type Track,
} from "@ableton-extensions/sdk";
import type { Ctx } from "./state.js";

// ---------- Current-Set identity for the system prompt ----------
//
// Chat sessions are global (chats.json), not per Live Set — so when the user
// opens a different Set mid-conversation, the model still sees the previous
// Set's get_song_overview/analyze_song results in its history and happily
// answers from them. The SDK's Song object carries a stable per-document
// handle id: same document → same id, new document loaded → new id. We
// compare it once per user turn (updateSetContext, called from chat()) and
// expose two prompt lines via setContextPrompt():
//   - contextLine: a fresh one-line summary of the open Set, every turn, so
//     the model always has a current anchor;
//   - changeNotice: a loud warning injected for the one turn in which the
//     document id changed, telling the model its history is stale.

let lastSetKey: string | null = null;
let contextLine = "";
let changeNotice = "";
let focus: { handle: Handle; setKey: string | null } | null = null;
let focusLine = "";

type ArrangementSelectionState = {
  kind: "arrangement";
  handles: Handle[];
  startBeat: number;
  endBeat: number;
  setKey: string | null;
};

type SessionSelectionState = {
  kind: "session";
  handles: Handle[];
  setKey: string | null;
};

type SelectionState = ArrangementSelectionState | SessionSelectionState;

/** The concrete selection exposed to the prompt and tool boundary. Indices
 * are re-resolved from Live on every read so track edits cannot make an old
 * selection point at the wrong object. */
export type ResolvedSelection =
  | { kind: "arrangement"; tracks: { index: number; name: string }[]; startBeat: number; endBeat: number }
  | { kind: "session"; slots: { trackIndex: number; trackName: string; sceneIndex: number; clipName?: string }[] };

let selection: SelectionState | null = null;
let selectionLine = "";

interface SetFingerprint {
  key: string;
  desc: string;
}

function readFingerprint(context: Ctx): SetFingerprint | null {
  try {
    const song = context.application.song;
    // Handle.id is a bigint — String() normalizes it (and any unexpected
    // number form) for comparison and logging.
    const id = String((song.handle as { id?: unknown } | undefined)?.id ?? "");
    if (!id) return null;
    const tracks = song.tracks.length;
    const scenes = song.scenes.length;
    const tempo = Math.round(Number(song.tempo));
    return { key: id, desc: `${tracks} tracks, ${scenes} scenes, ${tempo} BPM` };
  } catch {
    // Song unreadable (Live busy, document mid-load) — skip rather than risk
    // a false "set changed" from a half-built object.
    return null;
  }
}

function sameObject(a: DataModelObject<"1.0.0">, b: DataModelObject<"1.0.0">): boolean {
  return a.handle.id === b.handle.id;
}

function trackLocation(
  context: Ctx,
  track: Track<"1.0.0">,
): { index: number; name: string } | null {
  const tracks = context.application.song.tracks;
  const index = tracks.findIndex((candidate) => sameObject(candidate, track));
  return index < 0 ? null : { index, name: track.name };
}

function trackForObject(
  context: Ctx,
  object: DataModelObject<"1.0.0">,
): Track<"1.0.0"> | null {
  let current: DataModelObject<"1.0.0"> | null = object;
  // A selected arrangement lane may be a track or a Take Lane. The latter's
  // canonical parent is the owning track. Keep a cap in case a malformed host
  // object reports a parent cycle.
  for (let i = 0; current && i < 4; i++) {
    if (current instanceof MidiTrack || current instanceof AudioTrack) return current;
    current = current.parent;
  }
  return null;
}

function clipLocation(context: Ctx, clip: Clip<"1.0.0">): string | null {
  for (const [trackIndex, track] of context.application.song.tracks.entries()) {
    const arrangementIndex = track.arrangementClips.findIndex((candidate) => sameObject(candidate, clip));
    if (arrangementIndex >= 0) {
      return `on track ${trackIndex} “${track.name}”, arrangement clip ${arrangementIndex}`;
    }
    const sceneIndex = track.clipSlots.findIndex((slot) => slot.clip && sameObject(slot.clip, clip));
    if (sceneIndex >= 0) return `on track ${trackIndex} “${track.name}”, Session scene ${sceneIndex}`;
  }
  return null;
}

function shortFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function describeClip(context: Ctx, clip: Clip<"1.0.0">): string {
  const kind = clip instanceof MidiClip ? "MIDI clip" : "audio clip";
  const location = clipLocation(context, clip);
  const place = location ? ` ${location}` : "";
  const timing = `, starts at beat ${Number(clip.startTime)}, lasts ${Number(clip.duration)} beats`;
  if (clip instanceof MidiClip) {
    return `${kind} “${clip.name}”${place}${timing}, ${clip.notes.length} notes`;
  }
  if (clip instanceof AudioClip) {
    return `${kind} “${clip.name}”${place}${timing}, source ${shortFileName(clip.filePath)}`;
  }
  return `${kind} “${clip.name}”${place}${timing}`;
}

function describeFocus(context: Ctx): string | null {
  if (!focus) return null;
  const object = context.getObjectFromHandle(focus.handle, DataModelObject);

  if (object instanceof MidiTrack || object instanceof AudioTrack) {
    const loc = trackLocation(context, object);
    if (!loc) return null;
    const kind = object instanceof MidiTrack ? "MIDI track" : "audio track";
    const devices = object.devices.slice(0, 4).map((device) => device.name);
    return `${kind} ${loc.index} “${loc.name}”, ${object.arrangementClips.length} arrangement clips` +
      (devices.length ? `, devices: ${devices.join(", ")}` : "");
  }

  if (object instanceof Scene) {
    const index = context.application.song.scenes.findIndex((scene) => sameObject(scene, object));
    if (index < 0) return null;
    return `Scene ${index} “${object.name}”, ${Number(object.signatureNumerator)}/${Number(object.signatureDenominator)}, ${Number(object.tempo)} BPM`;
  }

  if (object instanceof ClipSlot) {
    for (const [trackIndex, track] of context.application.song.tracks.entries()) {
      const sceneIndex = track.clipSlots.findIndex((slot) => sameObject(slot, object));
      if (sceneIndex < 0) continue;
      return object.clip
        ? `ClipSlot on track ${trackIndex} “${track.name}”, Session scene ${sceneIndex}; contains ${describeClip(context, object.clip)}`
        : `empty ClipSlot on track ${trackIndex} “${track.name}”, Session scene ${sceneIndex}`;
    }
    return null;
  }

  if (object instanceof MidiClip || object instanceof AudioClip) return describeClip(context, object);
  return null;
}

/** Store the Live object supplied by a context-menu command. Invalid command
 * arguments deliberately clear focus, so keyboard/programmatic opens cannot
 * accidentally inherit a previous right-click target. */
export function setRightClickFocus(context: Ctx, value: unknown): void {
  // A new single-object command supersedes an earlier multi-selection.
  clearSelectionContext();
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof (value as { id?: unknown }).id !== "bigint"
  ) {
    clearRightClickFocus();
    return;
  }
  focus = { handle: value as Handle, setKey: readFingerprint(context)?.key ?? null };
  focusLine = "";
}

function handlesFrom(value: unknown): Handle[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Handle =>
      Boolean(item) && typeof item === "object" &&
      "id" in item && typeof (item as { id?: unknown }).id === "bigint",
  );
}

/** Capture one of the SDK's structured context-menu selection payloads.
 * Returns true when the argument was a selection payload, including malformed
 * ones, so callers never accidentally treat it as an opaque object Handle. */
export function setSelectionContext(context: Ctx, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const setKey = readFingerprint(context)?.key ?? null;
  if ("selected_lanes" in raw) {
    const startBeat = Number(raw.time_selection_start);
    const endBeat = Number(raw.time_selection_end);
    const handles = handlesFrom(raw.selected_lanes);
    focus = null;
    focusLine = "";
    selection = handles.length && Number.isFinite(startBeat) && Number.isFinite(endBeat) && endBeat > startBeat
      ? { kind: "arrangement", handles, startBeat, endBeat, setKey }
      : null;
    selectionLine = "";
    return true;
  }
  if ("selected_clip_slots" in raw) {
    const handles = handlesFrom(raw.selected_clip_slots);
    focus = null;
    focusLine = "";
    selection = handles.length ? { kind: "session", handles, setKey } : null;
    selectionLine = "";
    return true;
  }
  return false;
}

/** Clear the transient context-menu target; it is never persisted to a chat. */
export function clearRightClickFocus(): void {
  focus = null;
  focusLine = "";
}

/** Clear the transient Live multi-selection; it is never persisted to chat. */
export function clearSelectionContext(): void {
  selection = null;
  selectionLine = "";
}

/** Resolve the selection against the current document. Invalid/deleted
 * handles are skipped; an empty result clears the selection. */
export function resolvedSelection(context: Ctx): ResolvedSelection | null {
  if (!selection) return null;
  const fp = readFingerprint(context);
  if (selection.setKey !== null && (!fp || selection.setKey !== fp.key)) {
    clearSelectionContext();
    return null;
  }
  try {
    if (selection.kind === "arrangement") {
      const tracks = selection.handles.flatMap((handle) => {
        try {
          const object = context.getObjectFromHandle(handle, DataModelObject);
          const track = trackForObject(context, object);
          const location = track && trackLocation(context, track);
          return location ? [location] : [];
        } catch {
          return [];
        }
      });
      const unique = tracks.filter((track, i) => tracks.findIndex((x) => x.index === track.index) === i);
      if (!unique.length) {
        clearSelectionContext();
        return null;
      }
      return { kind: "arrangement", tracks: unique, startBeat: selection.startBeat, endBeat: selection.endBeat };
    }
    const slots = selection.handles.flatMap((handle) => {
      try {
        const object = context.getObjectFromHandle(handle, DataModelObject);
        if (!(object instanceof ClipSlot)) return [];
        for (const [trackIndex, track] of context.application.song.tracks.entries()) {
          const sceneIndex = track.clipSlots.findIndex((slot) => sameObject(slot, object));
          if (sceneIndex >= 0) {
            return [{ trackIndex, trackName: track.name, sceneIndex, ...(object.clip ? { clipName: object.clip.name } : {}) }];
          }
        }
      } catch {
        // A selected slot may have been deleted after opening the dialog.
      }
      return [];
    });
    const unique = slots.filter(
      (slot, i) => slots.findIndex((x) => x.trackIndex === slot.trackIndex && x.sceneIndex === slot.sceneIndex) === i,
    );
    if (!unique.length) {
      clearSelectionContext();
      return null;
    }
    return { kind: "session", slots: unique };
  } catch {
    clearSelectionContext();
    return null;
  }
}

function refreshSelection(context: Ctx): void {
  const current = resolvedSelection(context);
  if (!current) return;
  if (current.kind === "arrangement") {
    const tracks = current.tracks.map((track) => `${track.index} “${track.name}”`).join(", ");
    selectionLine =
      `\nCurrent Arrangement selection: tracks ${tracks}, beats ${current.startBeat}–${current.endBeat} (end exclusive). ` +
      "Treat it as the default edit boundary; only leave it when the current user explicitly asks for the whole song/set.";
    return;
  }
  const slots = current.slots.map((slot) =>
    `${slot.trackIndex} “${slot.trackName}” / scene ${slot.sceneIndex}${slot.clipName ? ` “${slot.clipName}”` : ""}`,
  ).join("; ");
  selectionLine =
    `\nCurrent Session selection: ${slots}. Treat these slots (and their tracks) as the default edit boundary; ` +
    "only leave it when the current user explicitly asks for the whole song/set.";
}

function refreshFocus(context: Ctx): void {
  if (!focus) return;
  try {
    const desc = describeFocus(context);
    if (!desc) {
      clearRightClickFocus();
      return;
    }
    focusLine =
      `\nCurrent right-click focus: ${desc}. Treat this as the likely target of “this” or “it”, ` +
      "but read the current Set/Clip state before any mutation.";
  } catch {
    // The user may have deleted the object since opening the dialog.
    clearRightClickFocus();
  }
}

/** Called once per user turn from chat() BEFORE the provider request.
 * Returns the document key + change flag so the caller can debug-log it. */
export function updateSetContext(context: Ctx): { key: string; changed: boolean } | null {
  const fp = readFingerprint(context);
  if (!fp) return null; // keep the previous lines — better stale than blank
  const changed = lastSetKey !== null && fp.key !== lastSetKey;
  // A focus made in the new Set immediately after switching must survive the
  // first chat turn. Only clear when its own recorded document differs.
  if (focus && focus.setKey !== null && focus.setKey !== fp.key) clearRightClickFocus();
  if (selection && selection.setKey !== null && selection.setKey !== fp.key) clearSelectionContext();
  changeNotice = changed
    ? "\n⚠️ SET CHANGED: the user opened a DIFFERENT Live Set since the previous message. " +
      "Everything earlier in this conversation (overviews, analysis, goals, plans) describes the OLD Set — " +
      "never reuse its track names, indices or analysis. Call get_song_overview now and work only from fresh data."
    : "";
  lastSetKey = fp.key;
  contextLine = `\nCurrent Live Set: ${fp.desc}.`;
  refreshFocus(context);
  refreshSelection(context);
  return { key: fp.key, changed };
}

/** Appended to the system prompt by systemPromptFor(). */
export function setContextPrompt(): string {
  return contextLine + changeNotice + focusLine + selectionLine;
}
