/**
 * music/features/types.ts — public structures of the Musical Feature Model.
 *
 * Layer position:
 *
 *   MusicState (what is) → MusicalFeatures (comparable/plannable quantities)
 *                        → (future) Relationships → Reasoning → Creative Actions
 *
 * Rules (PR11 scope — enforced by construction, not convention):
 * - Pure: MusicState (+ optional MusicAnalysis for role labels) in, features
 *   out. No Live SDK, no filesystem, no network, no server, no model.
 * - Deterministic: same MusicState → identical features, every run.
 * - No LLM: every number here is computed, never generated.
 * - Read-only: features never mutate state and never touch Live.
 *
 * Two honesty rules that every consumer (and every future PR) must preserve:
 *
 * 1. undefined means "no reliable data" — NEVER faked as 0. A track with no
 *    analyzed audio has lowEnergy === undefined, so an agent reads "not
 *    analyzed", not "no low end". Zeros only ever appear as real facts
 *    (a section with no MIDI notes genuinely has density 0 — MIDI knowledge
 *    is complete).
 *
 * 2. impact / tension / release / energy are HEURISTIC PROXIES, not
 *    music-theoretic truth. They ship as FeatureValue with source "derived"
 *    and a confidence equal to the fraction of their declared input
 *    components that had data. Read "impact proxy = 0.83 (seen 3/5 inputs)",
 *    never "this section's impact is 0.83".
 */

import type { TrackRole } from "../../analysis/types.js";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Where a feature's number came from:
 * - "midi":    computed from note facts (complete knowledge of MIDI content)
 * - "audio":   computed from clip SOURCE FILE analysis (pre-warp, pre-gain,
 *              pre-device — does not describe the audible mix)
 * - "derived": heuristic combination of other features (a proxy, not a fact)
 */
export type FeatureSource = "midi" | "audio" | "derived";

export interface FeatureValue {
  value: number;
  source: FeatureSource;
  /** 0-1. On derived features: fraction of the declared input components that
   * had data (1 = full evidence). Absent on direct measurements. */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Track features
// ---------------------------------------------------------------------------

export interface TrackFeatures {
  /** Snapshot track index as a string id — Live exposes no persistent id. */
  trackId: string;
  name: string;
  /** track.mute || mutedViaSolo. Audible fields are undefined/0 when true. */
  muted: boolean;
  /** Role label from the interpretation layer — only present when
   * buildMusicalFeatures was given the MusicAnalysis. */
  role?: TrackRole;

  // --- MIDI facts (undefined = no audible MIDI material) ---

  /** audible notes / bar over the track's active span (notes × loop repeats
   * ÷ span incl. tiling). Raw ratio, may exceed 1. */
  density?: number;
  /** pitchMax − pitchMin in semitones. */
  pitchRange?: number;
  /** velMax − velMin in velocity units (0-127 scale). */
  velocityRange?: number;
  /** 0-1: share of audible onsets produced by loop repeats
   * (1 − single-pass onsets / total onsets over the track's clips).
   * A track of one-shots reads 0; one loop played 4× reads 0.75. */
  repetition?: number;
  /** 1 − repetition. */
  variation?: number;

  /** 0-1: union of the track's audible arrangement clip spans ÷ arrangement
   * length. 0 when the arrangement is empty or the track has no audible
   * arrangement clips (session-only track). */
  activeRatio: number;

  /** 0-1 onsets/bar, 16 onsets/bar = 1.0 (16th-note coverage in 4/4).
   * MIDI tracks: from note onsets (source "midi"). Audio tracks: from
   * source-file transient density converted via tempo (source "audio"). */
  rhythmicActivity?: FeatureValue;

  // --- Audio source-file features (undefined without analysis) ---

  /** Spectral share of sub+bass bands (fraction of the clip's spectrum). */
  lowEnergy?: FeatureValue;
  /** Spectral share of lowMid+mid bands. */
  midEnergy?: FeatureValue;
  /** Spectral share of highMid+high bands. */
  highEnergy?: FeatureValue;
  /** Onsets/sec from spectral flux (raw, not normalized). */
  transientDensity?: FeatureValue;
}

// ---------------------------------------------------------------------------
// Section features
// ---------------------------------------------------------------------------

export interface SectionFeatures {
  /** Section index (in arrangement order) as a string id. */
  sectionId: string;
  /** Cue name, or "bars N-M" when sectionized without cue points. */
  name: string;
  startBeat: number;
  endBeat: number;
  /** Section length in bars ((endBeat − startBeat) / barBeats). */
  bars: number;

  // --- MIDI facts ---

  /** Audible MIDI onsets in the section ÷ bars. 0 is a real fact: the section
   * genuinely has no notes (audio-only sections included — see energyAudio /
   * transientDensity for their activity). */
  density: number;
  /** Tracks with audible material in this section ÷ tracks with audible
   * arrangement material anywhere. */
  activeTrackRatio: number;
  /** 0-1: share of the section's onsets that come from loop repeats
   * (per clip: onsets × (passes − 1) / passes, summed). undefined when the
   * section has no MIDI onsets. */
  repetition?: number;
  /** 1 − repetition. */
  variation?: number;

  /** 0-1 onsets/bar (16/bar = 1.0). MIDI onsets preferred when the section
   * has notes (source "midi"); otherwise source-file transients of the
   * overlapping audio clips (source "audio"). */
  rhythmicActivity?: FeatureValue;

  // --- Audio source-file features of the clips overlapping the section
  //     (overlap-duration weighted; undefined without analysis) ---

  lowEnergy?: FeatureValue;
  midEnergy?: FeatureValue;
  highEnergy?: FeatureValue;
  /** Spectral centroid, log-scaled to 0-1 (200 Hz = 0, 8 kHz = 1). */
  spectralBrightness?: FeatureValue;
  /** Onsets/sec (raw). */
  transientDensity?: FeatureValue;
  /** Loudness range in dB (LRA-style p95−p10, raw). */
  dynamicRange?: FeatureValue;

  // --- Energy family (kept distinct on purpose: §10 of the PR11 spec) ---

  /** MIDI activity proxy: weighted(density normalized, activeTrackRatio,
   * mean velocity). 0 is a real fact (section genuinely silent of notes). */
  energyMidi?: FeatureValue;
  /** Normalized source-file loudness of overlapping audio clips
   * (heuristic anchors: −45 dBFS = 0, −8 dBFS = 1). */
  energyAudio?: FeatureValue;
  /** Combined section energy: mean of the available energyMidi / energyAudio.
   * source "derived"; confidence = how many of the two were present. */
  energy?: FeatureValue;

  // --- Heuristic proxies (NOT music-theoretic measurements) ---

  /** Impact proxy = weighted(density 0.25, activeTrackRatio 0.20,
   * transientDensity 0.20, lowEnergy 0.20, highEnergy 0.15) over the
   * components that have data; confidence = input coverage. */
  impact?: FeatureValue;
  /** Tension proxy = weighted(high-frequency energy or brightness 0.5,
   * rhythmicActivity 0.5). */
  tension?: FeatureValue;
  /** Release proxy = weighted(1−density 0.4, 1−rhythmicActivity 0.3,
   * 1−high-frequency energy 0.3). */
  release?: FeatureValue;
}

// ---------------------------------------------------------------------------
// Song features
// ---------------------------------------------------------------------------

export interface SongFeatures {
  durationBeats: number;
  bars: number;
  trackCount: number;
  midiTrackCount: number;
  audioTrackCount: number;
  tempo: number;
  sectionCount: number;
  /** Mean of section densities; undefined when there are no sections. */
  avgDensity?: number;
  /** Mean of section activeTrackRatio; undefined when there are no sections. */
  avgActiveTrackRatio?: number;
  /** Min/max/range of the derived section energy values; undefined when no
   * section produced an energy value. */
  minEnergy?: number;
  maxEnergy?: number;
  energyRange?: number;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface MusicalFeatures {
  song: SongFeatures;
  sections: SectionFeatures[];
  tracks: TrackFeatures[];
}
