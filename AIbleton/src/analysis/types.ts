/**
 * analysis/types.ts — MusicAnalysis: the interpretation layer, plus the
 * SongAnalysis presentation DTO.
 *
 * MusicState (musicstate/) answers "what is in the Set"; MusicAnalysis answers
 * "what does it mean" — key, track roles, section energy, issues — as
 * structured, unrounded, uncut data that machine consumers (goal/plan/verify)
 * can judge against. SongAnalysis is the model-facing rendering of the same
 * content: numbers rounded, issues stringified, tail cut by fitBudget.
 */

import type { AudioBands } from "../dsp.js";

// ---------------------------------------------------------------------------
// Interpretation output (MusicState -> MusicAnalysis, interpret.ts)
// ---------------------------------------------------------------------------

export type TrackRole =
  | "kick" | "snare" | "clap" | "hats" | "cymbal" | "tom"
  | "drums" | "percussion"
  | "bass" | "chords" | "pad" | "lead" | "arp" | "vocal" | "fx" | "unknown";

export interface KeyAnalysis {
  status: "ok" | "insufficient_material";
  best?: string; // "F# minor"
  confidence?: "high" | "medium" | "low";
  r?: number; // best Pearson correlation (raw in MusicAnalysis, 2 dp in SongAnalysis)
  margin?: number; // r1 - r2
  candidates?: [string, number][]; // top-3 (may be cut to 1 by fitBudget)
}

export interface SectionAnalysis {
  name: string; // cue name or "bars 9-16"
  bars: [number, number]; // 1-based inclusive
  energy: "low" | "mid" | "high";
  tracks: number; // tracks with >= 1 onset in this section
  notes: number;
  /** Presentation-only (present.ts, focused render): indices of the SELECTED
   * tracks audible in this section. interpret.ts never fills this. */
  focusTracks?: number[];
}

/** Role attribution for one track. isDrums is the classification that kept
 * the track out of the key histogram — kept here so consumers don't re-derive
 * it from the name. */
export interface TrackRoleAnalysis {
  i: number; // track index (matches get_song_overview)
  role: TrackRole;
  isDrums: boolean;
}

/** Closed vocabulary — presentation stringifies as "CODE: message". */
export type IssueCode =
  | "EMPTY_SET" | "NO_ARRANGEMENT" | "SINGLE_LOOP" | "LOW_CONTRAST"
  | "DUPLICATE_CONTENT" | "KEY_MISMATCH" | "OFF_KEY"
  | "NO_LOW_END" | "NO_HIGH_END" | "FLAT_DYNAMICS" | "MONOTONE_BASS"
  | "MUTED_CONTENT"
  | "WEAK_TRANSIENTS" | "THIN_LOW_END" | "SQUASHED_DYNAMICS"
  | "DULL_HIGH_END" | "HARSH_HIGH_END";

export interface MusicIssue {
  code: IssueCode;
  message: string; // human-readable evidence; presentation emits "CODE: message"
  tracks?: number[]; // track indices involved (DUPLICATE_CONTENT, FLAT_DYNAMICS, MONOTONE_BASS)
}

/**
 * Per-track aggregate of the audio features of its audible arrangement
 * clips (bands/centroid energy-weighted, the rest duration-weighted — see
 * interpret.aggregateTrackAudio). Single producer; present.ts and
 * goal/view.ts both consume this, never re-aggregate. Features describe
 * clip SOURCE FILES (pre-warp, pre-gain, pre-device), not the audible
 * result.
 */
export interface TrackAudioAnalysis {
  clips: number; // arrangement clips contributing features
  failedClips: number; // attempted but unreadable/undecodable
  durationSec: number; // sum of contributing clip durations
  rmsDb: number;
  crestDb: number;
  loudnessDb: number;
  dynamicRangeDb?: number; // undefined when no contributing clip had it
  spectralCentroidHz: number;
  bands: AudioBands;
  transientDensity?: number;
  partial?: true; // any contributing clip was truncated
}

/** Stats of one audiofiles.enrichMusicStateWithAudio run. The shape lives in
 * this pure module so audiofiles (impure) can be imported BY, not import
 * FROM, the analysis layer. */
export interface AudioEnrichStats {
  computed: number; // files decoded + analyzed this run
  cached: number; // clips served from the feature cache
  failed: number; // clips attempted but errored
  skipped: number; // eligible clips left unprocessed (file/time budget)
}

/** Reserved slot — no producer yet. A future PR derives suggestions from
 * issues (and keeps them deduplicated against them). */
export interface MusicRecommendation {
  action: string;
  reason?: string;
}

/** Duration-weighted share of audible note material outside the governing
 * scale — Live's declared scale when Scale Mode is on, else the detected key.
 * Drums and muted content are excluded. Absent when no scale is usable or
 * material is too thin to judge: an UNKNOWABLE, never a zero. */
export interface OffKeyMeasure {
  ratio: number; // out-of-scale duration / total duration (0-1)
  scaleLabel: string; // scale judged against, for messages
  scaleSource: "live" | "detected";
}

export interface MusicAnalysis {
  key: KeyAnalysis;
  sections: SectionAnalysis[];
  trackRoles: TrackRoleAnalysis[];
  issues: MusicIssue[];
  recommendations?: MusicRecommendation[];
  /** Present only when a governing scale exists and material suffices. */
  offKey?: OffKeyMeasure;
  /** Parallel to trackRoles, indexed by state.tracks position; null per
   * track without analyzed audio. undefined when no clip anywhere has
   * features (audio enrichment never ran). */
  trackAudio?: (TrackAudioAnalysis | null)[];
}

// ---------------------------------------------------------------------------
// Presentation output (MusicAnalysis -> SongAnalysis, present.ts)
// ---------------------------------------------------------------------------

export interface TrackAnalysis {
  i: number; // same order as get_song_overview
  name: string;
  role: TrackRole;
  notes: number; // audible notes incl. loop repeats
  range?: string; // "F#1-C#2"
  dens?: number; // audible notes / bar over the track's active span
  poly?: number; // sum(duration) / single-pass span
  vel?: [number, number, number]; // min, max, avg
  ent?: number; // 0-1 rhythm entropy; omitted with < 8 onsets
  uniq?: number; // unique pitches
  clips: number;
  muted?: true;
  audio?: {
    clips: number;
    bars: number;
    files?: string[];
    /** Source-file audio features (present only when analyze_song ran with
     * audio:true). rms/crest/dyn/loud in dBFS, centroid in Hz, trans in
     * onsets/sec, bands as energy fractions summing to ≈1. */
    feat?: {
      rms: number;
      crest: number;
      dyn?: number;
      loud: number;
      centroid: number;
      trans?: number;
      bands: AudioBands;
      partial?: true;
    };
  };
}

/** One clip in the flat clip map — the coordinate system arrange_song plans
 * against: (t, i) addresses arrangement clips, (t, scene) session clips. */
export interface ClipEntry {
  t: number; // track index (matches TrackAnalysis.i / get_song_overview)
  i?: number; // arrangement clip_index on that track (arrangement clips only)
  scene?: number; // session slot index (session clips only)
  name: string;
  kind: "midi" | "audio";
  bar?: number; // 1-based start bar (arrangement clips)
  bars?: number; // clip length in bars (arrangement clips)
  loop?: number; // loop length in bars — the unit arrange_song tiles (looping clips)
  muted?: true;
}

/** Echo of the analyze_song focus parameter (select.ts): what the caller
 * asked for and what it matched. unmatched: the focus matched nothing and
 * the full analysis was returned instead. */
export interface FocusEcho {
  raw: string;
  matched: string[]; // e.g. ["track:Bass", "role:bass", "issue:MONOTONE_BASS"]
  unmatched?: true;
}

export interface SongAnalysis {
  tempo: number;
  timeSig: string;
  liveScale: { mode: boolean; root: string; name: string } | null;
  key: KeyAnalysis;
  arrangement: { bars: number; beats: number } | null;
  sections: SectionAnalysis[];
  tracks: TrackAnalysis[];
  tracksOmitted?: number;
  clips: ClipEntry[];
  clipsOmitted?: number;
  session: { scenes: number; clips: number; tracks: number; notes: number };
  issues: string[];
  caveat: string;
  focus?: FocusEcho;
  /** Present when analyze_song ran with audio:true. note explains when no
   * features landed ("no audio clips in the Set" / all skipped/failed). */
  audioRun?: AudioEnrichStats & { note?: string };
}
