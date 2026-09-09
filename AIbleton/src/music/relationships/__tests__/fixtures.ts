/**
 * PR12 test fixtures: multi-section songs built from the features layer's
 * own builders (single producer — never re-implement note/clip/track here).
 */

import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import type {
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
} from "../../../musicstate/types.js";
import type { MusicalFeatures } from "../../features/types.js";
import {
  audioClip,
  fourOnFloor,
  midiClip,
  note,
  snapshot,
  track,
} from "../../features/__tests__/fixtures.js";

export {
  audioClip,
  audioFeatures,
  fourOnFloor,
  midiClip,
  note,
  snapshot,
  stateWithAudio,
  track,
} from "../../features/__tests__/fixtures.js";

/** 16th-note pulse: 4 onsets per beat, `bars` bars of material. */
export function sixteenthNotes(bars: number, pitch = 36): SnapshotNote[] {
  const out: SnapshotNote[] = [];
  for (let b = 0; b < bars * 4; b++) {
    for (let s = 0; s < 4; s++) out.push(note(pitch, b + s * 0.25, 0.25));
  }
  return out;
}

/** Onsets-per-bar loop material (1-bar loops) for densityShapeSong. */
const PATTERNS: Record<number, () => SnapshotNote[]> = {
  1: () => [note(60, 0, 1)],
  4: () => fourOnFloor(1),
  16: () => sixteenthNotes(1),
};

/** One MIDI track, one 8-bar section per entry of `densities` (onsets/bar;
 * 0 = empty section, held open by a muted audio pad so the arrangement
 * still extends). Cue points "S0","S1",… at section starts. Velocity and
 * the single audible track stay constant, so section energy moves with
 * density alone → deterministic arc shapes. */
export function densityShapeSong(densities: number[]): MusicalFeatures {
  const sectionBeats = 8 * 4;
  const midiClips: SnapshotClip[] = [];
  const padClips: SnapshotClip[] = [];
  const cuePoints: { time: number; name: string }[] = [];
  densities.forEach((d, i) => {
    const start = i * sectionBeats;
    cuePoints.push({ time: start, name: `S${i}` });
    if (d > 0) {
      const pattern = PATTERNS[d];
      if (pattern === undefined) throw new Error(`no pattern for density ${d}`);
      midiClips.push(midiClip(`m${i}`, pattern(), { start, duration: sectionBeats }));
    } else {
      padClips.push(audioClip(`p${i}`, { start, duration: sectionBeats, muted: true }));
    }
  });
  const tracks: SnapshotTrack[] = [track(0, "Keys", "midi", midiClips)];
  if (padClips.length > 0) tracks.push(track(1, "Pad", "audio", padClips));
  return buildMusicalFeatures(buildMusicState(snapshot(tracks, { cuePoints })));
}
