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

/** Called once per user turn from chat() BEFORE the provider request.
 * Returns the document key + change flag so the caller can debug-log it. */
export function updateSetContext(context: Ctx): { key: string; changed: boolean } | null {
  const fp = readFingerprint(context);
  if (!fp) return null; // keep the previous lines — better stale than blank
  const changed = lastSetKey !== null && fp.key !== lastSetKey;
  changeNotice = changed
    ? "\n⚠️ SET CHANGED: the user opened a DIFFERENT Live Set since the previous message. " +
      "Everything earlier in this conversation (overviews, analysis, goals, plans) describes the OLD Set — " +
      "never reuse its track names, indices or analysis. Call get_song_overview now and work only from fresh data."
    : "";
  lastSetKey = fp.key;
  contextLine = `\nCurrent Live Set: ${fp.desc}.`;
  return { key: fp.key, changed };
}

/** Appended to the system prompt by systemPromptFor(). */
export function setContextPrompt(): string {
  return contextLine + changeNotice;
}
