/**
 * Test fixtures: typed builders for SongSnapshot / MusicState / AudioFeatures.
 * All builders take explicit indices (no global counters) so tests stay
 * deterministic and order-independent.
 */

import type { AudioFeatures } from "../../../dsp.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import type {
  MusicState,
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
  SongSnapshot,
} from "../../../musicstate/types.js";

export function note(
  pitch: number,
  start: number,
  duration = 1,
  velocity = 100,
): SnapshotNote {
  return { pitch, start, duration, velocity };
}

/** 4-on-the-floor: one note per beat, `bars` bars long, full-beat durations. */
export function fourOnFloor(bars: number, pitch = 36): SnapshotNote[] {
  const out: SnapshotNote[] = [];
  for (let b = 0; b < bars * 4; b++) out.push(note(pitch, b, 1));
  return out;
}

export function midiClip(
  name: string,
  notes: SnapshotNote[],
  overrides: Partial<SnapshotClip> = {},
): SnapshotClip {
  return {
    kind: "midi",
    name,
    start: 0,
    duration: 4,
    looping: true,
    loopStart: 0,
    loopEnd: 4,
    startMarker: 0,
    muted: false,
    notes,
    ...overrides,
  };
}

export function audioClip(
  name: string,
  overrides: Partial<SnapshotClip> = {},
): SnapshotClip {
  return {
    kind: "audio",
    name,
    start: 0,
    duration: 4,
    looping: false,
    loopStart: 0,
    loopEnd: 4,
    startMarker: 0,
    muted: false,
    file: `${name}.wav`,
    filePath: `/tmp/${name}.wav`,
    ...overrides,
  };
}

export function track(
  index: number,
  name: string,
  type: "midi" | "audio",
  clips: SnapshotClip[],
  overrides: Partial<SnapshotTrack> = {},
): SnapshotTrack {
  return {
    index,
    name,
    type,
    mute: false,
    mutedViaSolo: false,
    devices: [],
    clips,
    ...overrides,
  };
}

export function snapshot(
  tracks: SnapshotTrack[],
  overrides: Partial<SongSnapshot> = {},
): SongSnapshot {
  return {
    tempo: 120,
    timeSig: { numerator: 4, denominator: 4 },
    liveScale: { mode: false, root: 0, name: "", intervals: [] },
    cuePoints: [],
    sceneCount: 0,
    tracks,
    ...overrides,
  };
}

export function audioFeatures(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    durationSec: 8,
    sampleRate: 44100,
    channels: 2,
    rmsDb: -18,
    peakDb: -6,
    crestDb: 12,
    loudnessDb: -20,
    spectralCentroidHz: 2000,
    bands: { sub: 0.1, bass: 0.2, lowMid: 0.15, mid: 0.25, highMid: 0.2, high: 0.1 },
    transientDensity: 4,
    ...overrides,
  };
}

/** buildMusicState + attach source-file features to one clip — the offline
 * equivalent of audiofiles.enrichMusicStateWithAudio. */
export function stateWithAudio(
  snap: SongSnapshot,
  audio: { trackPos: number; clipPos: number; features: AudioFeatures }[],
): MusicState {
  const state = buildMusicState(snap);
  for (const a of audio) {
    state.tracks[a.trackPos].clips[a.clipPos].audio = { features: a.features };
  }
  return state;
}
