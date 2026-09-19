import {
  AudioClip,
  AudioTrack,
  Clip,
  ClipSlot,
  DataModelObject,
  MidiClip,
  MidiTrack,
  Scene,
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

/** Clear the transient context-menu target; it is never persisted to a chat. */
export function clearRightClickFocus(): void {
  focus = null;
  focusLine = "";
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
  changeNotice = changed
    ? "\n⚠️ SET CHANGED: the user opened a DIFFERENT Live Set since the previous message. " +
      "Everything earlier in this conversation (overviews, analysis, goals, plans) describes the OLD Set — " +
      "never reuse its track names, indices or analysis. Call get_song_overview now and work only from fresh data."
    : "";
  lastSetKey = fp.key;
  contextLine = `\nCurrent Live Set: ${fp.desc}.`;
  refreshFocus(context);
  return { key: fp.key, changed };
}

/** Appended to the system prompt by systemPromptFor(). */
export function setContextPrompt(): string {
  return contextLine + changeNotice + focusLine;
}
