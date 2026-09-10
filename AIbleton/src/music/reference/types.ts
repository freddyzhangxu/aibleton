/**
 * music/reference/types.ts — public structures of Reference Track Intelligence.
 *
 * Layer position:
 *
 *   Reference Audio → ReferenceAnalysis → ReferenceSection → ReferenceAlignment
 *                   → ReferenceGap → CreativeActions → SectionPlanningContext
 *                   → Planner → Live → Verification
 *
 * A reference is a SECOND intelligence input next to the current Live Set —
 * never a second feature model: every feature here reuses the PR11
 * FeatureValue semantics (undefined = "no reliable data", never a fabricated
 * 0), and every derived action reuses the PR14 vocabulary. The reference is
 * an evidence source, not something to clone (§80): gaps describe measurable
 * differences, the planner decides what matters for the user's goal, and
 * User Goal > Reference, always.
 *
 * Rules (enforced by construction, not convention):
 * - No Live SDK, no LLM, no server. analyze.ts is the ONLY module that may
 *   touch audio input (a Buffer — file I/O stays in the extension layer).
 * - Deterministic: same audio + same current features → identical analysis,
 *   alignments, gaps, actions, presentation, every run.
 * - Honest: an unmeasurable metric stays undefined; a weak section-role
 *   inference ships with a low confidence, never as fact.
 */

import type { FeatureValue } from "../features/types.js";
import type { CreativeAction } from "../actions/types.js";

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** Where the reference audio comes from. "live_audio" is reserved for a
 * future rendered-track source — the PR16 runtime implements "audio_file"
 * only; the type exists so the pipeline shape doesn't change later. */
export type ReferenceSource =
  | {
      type: "audio_file";
      path: string;
      name?: string;
    }
  | {
      type: "live_audio";
      trackId: string;
      name?: string;
    };

/** Why a reference could not be produced — a first-class answer, never a
 * thrown error. A reference is an enhancement: any of these states leaves
 * the plain MusicIntelligence flow fully working (§62). */
export type ReferenceError =
  | "reference_unavailable" // unreadable file / unsupported source type
  | "reference_analysis_failed" // decode or DSP failure
  | "reference_empty" // decoded but no usable audio (silence / 0 frames)
  | "reference_partial" // analysis truncated (maxSeconds) — usable, degraded
  | "reference_no_sections" // analyzed, but no section structure found
  | "reference_no_alignment"; // sections exist, none matched the current set

// ---------------------------------------------------------------------------
// Features — PR11 semantics, reference context
// ---------------------------------------------------------------------------

/** The measurable feature surface of a reference (whole file or one section).
 * Field semantics mirror SectionFeatures; audio-only provenance means
 * variation/repetition (MIDI facts) are usually undefined here — an honest
 * "we don't know", never a 0. */
export interface ReferenceFeatures {
  /** Normalized loudness (anchors −45 dBFS = 0, −8 = 1), source "audio". */
  energy?: FeatureValue;
  /** Onsets/bar (raw) — requires a tempo; undefined without one. */
  density?: FeatureValue;
  /** 0-1 onsets/bar (16/bar = 1.0) — requires a tempo. */
  rhythmicActivity?: FeatureValue;

  /** Spectral share of sub+bass bands. */
  lowEnergy?: FeatureValue;
  /** Spectral share of lowMid+mid bands. */
  midEnergy?: FeatureValue;
  /** Spectral share of highMid+high bands. */
  highEnergy?: FeatureValue;

  /** Spectral centroid, log-scaled 0-1 (200 Hz = 0, 8 kHz = 1). */
  spectralBrightness?: FeatureValue;
  /** Onsets/sec from spectral flux (raw). */
  transientDensity?: FeatureValue;
  /** Loudness range in dB (LRA-style p95−p10, raw). */
  dynamicRange?: FeatureValue;

  /** MIDI facts — no reliable audio-only evidence: normally undefined. */
  activeRatio?: FeatureValue;
  variation?: FeatureValue;
  repetition?: FeatureValue;

  /** Heuristic proxies (source "derived"; confidence = input coverage),
   * same component weights as PR11 minus the track-based ones a mixed audio
   * file cannot see. */
  impact?: FeatureValue;
  tension?: FeatureValue;
  release?: FeatureValue;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type ReferenceSectionRole =
  | "intro"
  | "build"
  | "drop"
  | "breakdown"
  | "verse"
  | "chorus"
  | "bridge"
  | "outro"
  | "unknown";

export interface ReferenceSection {
  /** Deterministic: "reference:section:<index>" — stable identity for tests,
   * caches and alignments. Never a random UUID. */
  id: string;

  /** Display label derived from the inferred role ("Drop 2"); absent when
   * the role is unknown. */
  label?: string;

  /** Beat axis of the reference. When a tempo could be estimated (or was
   * provided) these are true beats; otherwise they ride a NOMINAL 120 BPM
   * grid (1 beat = 0.5 s) — a documented analysis coordinate system, never
   * a tempo claim. */
  startBeat: number;
  endBeat: number;

  /** INFERRED function, not metadata — read with the confidence. */
  role?: ReferenceSectionRole;

  features: ReferenceFeatures;

  /** 0-1: trust in the boundary placement and the role inference. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** How far the analysis reached — every value 0..1 (0 = no evidence). */
export interface ReferenceCoverage {
  /** Analyzed duration ÷ file duration (1 unless truncated by maxSeconds). */
  duration: number;
  /** Share of the analyzed span that produced an energy curve (≈ duration;
   * separate so a curve failure degrades honestly). */
  analyzedBeats: number;
  /** Share of declared ReferenceFeatures fields with data (whole-file). */
  featureCoverage: number;
  /** Share of the analyzed span covered by detected sections. */
  sectionCoverage: number;
}

export interface ReferenceAnalysis {
  source: ReferenceSource;

  /** True beats — only when a tempo was estimated or provided. */
  durationBeats?: number;
  durationSeconds?: number;

  /** Estimated/provided tempo (source "audio", confidence = autocorrelation
   * prominence); undefined when the estimate was too weak to trust. */
  tempo?: FeatureValue;
  /** Whole-file energy (same anchors as features.energy). */
  energy?: FeatureValue;

  features: ReferenceFeatures;

  sections: ReferenceSection[];

  coverage: ReferenceCoverage;

  /** Set when analysis was truncated by maxSeconds (partial evidence). */
  partial?: true;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

export type ReferenceAlignmentReason =
  | "role" // same inferred role ("drop" ↔ Drop 2)
  | "ordinal" // same instance within the role (Drop 2 ↔ ref Drop 2)
  | "energy_shape" // similar energy level
  | "density" // similar density level
  | "duration" // similar section length
  | "similarity" // composite fallback
  | "contrast"; // deliberate opposites (evidence, not a match)

export interface ReferenceAlignment {
  currentSectionId: string;
  referenceSectionId: string;

  /** 0-1 deterministic alignment score (weighted reason coverage). */
  score: number;
  /** 0-1: trust in the alignment inputs (weakest link of the reference
   * section's confidence and the score's evidence coverage). */
  confidence?: number;

  reasons: ReferenceAlignmentReason[];
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

export type ReferenceGapMetric =
  | "energy"
  | "density"
  | "active_track_ratio"
  | "rhythmic_activity"
  | "low_energy"
  | "mid_energy"
  | "high_energy"
  | "spectral_brightness"
  | "transient_density"
  | "dynamic_range"
  | "variation"
  | "repetition"
  | "impact"
  | "tension"
  | "release"
  | "section_contrast";

export interface ReferenceGap {
  metric: ReferenceGapMetric;

  current?: FeatureValue;
  reference?: FeatureValue;

  /** reference − current, in the metric's own units. */
  delta?: number;

  direction: "higher_in_reference" | "lower_in_reference" | "similar" | "unknown";

  /** 0-1: magnitude of the difference (anchors: 0.05 ≈ weak, 0.4 = 1.0) —
   * ORTHOGONAL to confidence. */
  strength: number;
  /** weakest-link of current / reference / alignment confidences; omitted
   * when none carries one (never faked as 1). */
  confidence?: number;

  currentSectionId?: string;
  referenceSectionId?: string;
}

// ---------------------------------------------------------------------------
// Intelligence container
// ---------------------------------------------------------------------------

export interface ReferenceIntelligence {
  analysis: ReferenceAnalysis;

  /** One per alignable current section, best-first. */
  alignments: ReferenceAlignment[];

  /** Gaps for the PRIMARY alignment (the goal's target when one resolved,
   * else the best-scoring alignment). Empty without a primary. */
  gaps: ReferenceGap[];

  /** Conservative actions derived from the primary alignment's gaps —
   * planner hints, never commands. */
  actions: CreativeAction[];

  coverage: {
    /** Whole-file feature coverage of the analysis. */
    analysis: number;
    /** Primary alignment score (0 without one). */
    alignment: number;
    /** Comparable metrics ÷ declared gap metrics. */
    gap: number;
    /** Gaps that produced an action ÷ comparable gaps. */
    actionableGap: number;
  };
}

// ---------------------------------------------------------------------------
// Planner projection
// ---------------------------------------------------------------------------

/** The compact, budget-renderable slice the planner sees — never the full
 * ReferenceAnalysis. */
export interface ReferencePlanningContext {
  currentSectionId: string;

  referenceSectionId?: string;

  comparison: {
    metric: ReferenceGapMetric;
    current?: number;
    reference?: number;
    delta?: number;
    confidence?: number;
  }[];

  gaps: ReferenceGap[];

  /** Reference-derived actions, ranked (max 5) — hints, not commands. */
  actions: CreativeAction[];

  /** Comparable metrics ÷ declared gap metrics for this pairing. */
  coverage: number;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ReferenceVerification {
  metric: ReferenceGapMetric;

  beforeGap?: number;
  afterGap?: number;

  /** abs(beforeGap) − abs(afterGap): positive = moved TOWARD the reference. */
  gapReduction?: number;

  /** gapReduction ≥ REFERENCE_GAP_REDUCTION_EPSILON. Note: "satisfied" means
   * "closer", never "identical" — afterGap === 0 is NOT required (§41). */
  satisfied?: boolean;

  confidence?: number;
}
