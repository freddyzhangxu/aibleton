/**
 * musicstate/types.ts — MusicState: the lossless facts layer.
 *
 * MusicState answers "what is in the Set right now" — nothing about what it
 * means. Two halves:
 * - SongSnapshot: plain-data input built by server.ts from the Live SDK
 *   (serializable, fixture-testable offline).
 * - MusicState: the snapshot normalized, with every clip's audible window
 *   materialized (loops virtually unrolled, muted content excluded) and
 *   per-track measurements (note counts, pitch range, density, entropy…)
 *   computed without rounding or budget cuts.
 *
 * Interpretation (key/roles/section energy/issues) and presentation
 * (SongAnalysis JSON, fitBudget) live in analysis.ts — the layer that answers
 * "what does it mean".
 */

import type { AudioFeatures } from "../dsp.js";

// ---------------------------------------------------------------------------
// Snapshot input (built by server.ts from SDK objects)
// ---------------------------------------------------------------------------

export interface SnapshotNote {
  pitch: number;
  start: number; // beats, relative to clip start
  duration: number; // beats
  velocity: number; // builder defaults to 100
  muted?: boolean;
}

export interface SnapshotClip {
  kind: "midi" | "audio";
  name: string;
  start: number | null; // arrangement position in beats; null = session clip
  duration: number; // beats
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  startMarker: number;
  muted: boolean;
  notes?: SnapshotNote[]; // midi only
  file?: string; // audio only: basename
  filePath?: string; // audio only: absolute path from the SDK (source of audio analysis)
  arrIndex?: number; // index in track.arrangementClips — matches clip_index of get/set_clip_notes
  scene?: number; // clip-slot index, session clips only — matches scene_index of write_session_clip
}

export interface SnapshotTrack {
  index: number;
  name: string;
  type: "midi" | "audio";
  mute: boolean;
  mutedViaSolo: boolean;
  group?: string;
  drumPads?: number[]; // receivingNote of the first DrumRack's chains
  devices: string[]; // device names, max 6
  clips: SnapshotClip[]; // arrangement (start != null) + session (start = null)
}

export interface SongSnapshot {
  tempo: number;
  timeSig: { numerator: number; denominator: number };
  liveScale: { mode: boolean; root: number; name: string; intervals: number[] };
  cuePoints: { time: number; name: string }[];
  sceneCount: number;
  tracks: SnapshotTrack[];
}

// ---------------------------------------------------------------------------
// MusicState — facts and measurements, no interpretation
// ---------------------------------------------------------------------------

/** A clip's audible window: the loop region tiled by repeats, or a one-shot
 * played from the start marker. All beats relative to clip start. */
export interface ClipWindow {
  winStart: number;
  winEnd: number;
  loopLen: number;
  repeats: number;
}

/** One clip with its audible material: unmuted notes inside the window,
 * velocity defaulted, single pass (the repeat count lives on the window).
 * Material is empty for muted clips/tracks — the clip reference stays so
 * muted content can still be counted. */
export interface ClipState {
  clip: SnapshotClip;
  window: ClipWindow;
  material: SnapshotNote[];
  /**
   * Filled post-build by audiofiles.enrichMusicStateWithAudio (async, impure).
   * undefined = not attempted (no filePath, MIDI clip, or budget-skipped).
   * `error` means the file was attempted but could not be decoded/read.
   */
  audio?: { features?: AudioFeatures; error?: string };
}

/** Raw per-track measurements over audible arrangement material. No rounding
 * — number formatting belongs to the presentation layer. */
export interface TrackMeasurements {
  audibleNotes: number; // material notes x repeats
  materialCount: number; // single-pass
  pitchMin: number;
  pitchMax: number;
  uniq: number;
  sumDur: number; // single-pass
  spanSingle: number; // beats, first onset -> last offset, no repeat tiling
  spanAudible: number; // beats, incl. repeat tiling
  velMin: number;
  velMax: number;
  velAvg: number;
  onsetBeatsInBar: number[]; // single-pass onsets mapped into bar position
  sessionNotes: number;
  mutedNotes: number; // inside otherwise audible clips
}

export interface TrackState {
  track: SnapshotTrack;
  muted: boolean; // track.mute || track.mutedViaSolo — material is empty when true
  clips: ClipState[]; // same order as track.clips
  measurements: TrackMeasurements | null; // null when muted, or no material at all
}

export interface MusicState {
  snapshot: SongSnapshot; // normalized (defaults filled)
  barBeats: number; // beats per bar from timeSig
  tracks: TrackState[];
  arrangement: {
    endBeat: number; // 0 when the arrangement is empty
    bars: number; // endBeat / barBeats (0 when empty)
    hasClips: boolean; // any arrangement clip, any kind, muted or not
    midiClips: number; // arrangement MIDI clip count
  };
}
