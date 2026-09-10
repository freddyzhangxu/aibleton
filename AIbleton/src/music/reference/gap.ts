/**
 * music/reference/gap.ts — current section ↔ reference section: the gaps.
 *
 * Pure and deterministic. A gap exists only when BOTH sides carry the metric
 * (§24: current = undefined is "unknown", never delta = reference − 0), and a
 * difference below REFERENCE_GAP_EPSILON reads "similar", never a call to
 * action (§21). strength ⊥ confidence exactly as in the reasoning layer:
 * strength is how big the difference is, confidence is how much the inputs
 * can be trusted (weakest link of current / reference / alignment).
 *
 * verifyReferenceProgress is the after-execution counterpart: gap REDUCTION
 * as evidence (§42), never "identical to the reference" as the bar.
 */

import type { FeatureSource, FeatureValue, SectionFeatures } from "../features/types.js";
import { normRange, ONSETS_PER_BAR_FULL } from "../features/normalize.js";
import type {
  ReferenceGap,
  ReferenceGapMetric,
  ReferencePlanningContext,
  ReferenceSection,
  ReferenceVerification,
} from "./types.js";

/** A difference smaller than this is numerical noise, not a musical gap. */
export const REFERENCE_GAP_EPSILON = 0.05;

/** Gap reduction smaller than this is not a meaningful improvement (§43). */
export const REFERENCE_GAP_REDUCTION_EPSILON = 0.03;

/** strength anchors: |delta| 0.05 ≈ 0.125, 0.40 = 1.0 (§23). */
const STRENGTH_FULL_DELTA = 0.4;

export const REFERENCE_GAP_METRICS = [
  "energy",
  "density",
  "active_track_ratio",
  "rhythmic_activity",
  "low_energy",
  "mid_energy",
  "high_energy",
  "spectral_brightness",
  "transient_density",
  "dynamic_range",
  "variation",
  "repetition",
  "impact",
  "tension",
  "release",
  "section_contrast",
] as const;

// ---------------------------------------------------------------------------
// Metric readers — both sides as { value, confidence }; undefined = no data
// ---------------------------------------------------------------------------

interface Reading {
  value?: number;
  confidence?: number;
  /** Provenance of the original feature — echoed into the gap's FeatureValue
   * so the current/audio/derived chain is never laundered. */
  source?: FeatureSource;
}

function wrap(f: FeatureValue | undefined): Reading {
  return f === undefined ? {} : { value: f.value, confidence: f.confidence, source: f.source };
}

/** Raw MIDI facts (density/variation/repetition) carry no confidence. */
function rawFact(value: number | undefined, source: FeatureSource = "midi"): Reading {
  return value === undefined ? {} : { value, source };
}

/** Density compares on the normalized 16-onsets/bar axis, not raw onsets/bar:
 * a 0.1-notes/bar difference between two productions is noise, and the
 * epsilon/strength anchors assume a 0-1 axis. */
function densityNorm(x: number | undefined): number | undefined {
  return x === undefined ? undefined : normRange(x, 0, ONSETS_PER_BAR_FULL);
}

function currentReading(s: SectionFeatures, metric: ReferenceGapMetric): Reading {
  switch (metric) {
    case "energy": return wrap(s.energy);
    case "density": return rawFact(densityNorm(s.density));
    case "active_track_ratio": return rawFact(s.activeTrackRatio, "derived");
    case "rhythmic_activity": return wrap(s.rhythmicActivity);
    case "low_energy": return wrap(s.lowEnergy);
    case "mid_energy": return wrap(s.midEnergy);
    case "high_energy": return wrap(s.highEnergy);
    case "spectral_brightness": return wrap(s.spectralBrightness);
    case "transient_density": return wrap(s.transientDensity);
    case "dynamic_range": return wrap(s.dynamicRange);
    case "variation": return rawFact(s.variation);
    case "repetition": return rawFact(s.repetition);
    case "impact": return wrap(s.impact);
    case "tension": return wrap(s.tension);
    case "release": return wrap(s.release);
    default: return {};
  }
}

function referenceReading(s: ReferenceSection, metric: ReferenceGapMetric): Reading {
  const f = s.features;
  switch (metric) {
    case "energy": return wrap(f.energy);
    case "density": {
      const r = wrap(f.density);
      return r.value === undefined ? r : { ...r, value: densityNorm(r.value) };
    }
    case "rhythmic_activity": return wrap(f.rhythmicActivity);
    case "low_energy": return wrap(f.lowEnergy);
    case "mid_energy": return wrap(f.midEnergy);
    case "high_energy": return wrap(f.highEnergy);
    case "spectral_brightness": return wrap(f.spectralBrightness);
    case "transient_density": return wrap(f.transientDensity);
    case "dynamic_range": return wrap(f.dynamicRange);
    case "variation": return wrap(f.variation);
    case "repetition": return wrap(f.repetition);
    case "impact": return wrap(f.impact);
    case "tension": return wrap(f.tension);
    case "release": return wrap(f.release);
    default: return {}; // active_track_ratio: a mixed file has no track count
  }
}

/** |energy delta| of a section against its predecessor — the section's
 * contrast with what came before, on either side of the comparison. */
function predecessorContrast(sectionEnergy: Reading, prevEnergy: Reading): Reading {
  if (sectionEnergy.value === undefined || prevEnergy.value === undefined) return {};
  const conf =
    sectionEnergy.confidence !== undefined && prevEnergy.confidence !== undefined
      ? Math.min(sectionEnergy.confidence, prevEnergy.confidence)
      : (sectionEnergy.confidence ?? prevEnergy.confidence);
  return {
    value: Math.abs(sectionEnergy.value - prevEnergy.value),
    source: "derived",
    ...(conf !== undefined ? { confidence: conf } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gap derivation
// ---------------------------------------------------------------------------

export interface DeriveGapsOptions {
  /** Alignment confidence joins the weakest-link chain when present. */
  alignmentConfidence?: number;
  /** Predecessors feed the section_contrast metric (both sides required). */
  currentPrev?: SectionFeatures;
  referencePrev?: ReferenceSection;
}

/**
 * Derive every comparable gap between the current and the reference section.
 * Comparable = both sides carry the metric. Unknown-side metrics produce NO
 * gap (planner-facing honesty, §24) — coverage accounting counts them, the
 * planner never sees a fabricated comparison.
 *
 * Emission order follows REFERENCE_GAP_METRICS — byte-stable across runs.
 */
export function deriveReferenceGaps(
  current: SectionFeatures,
  reference: ReferenceSection,
  opts?: DeriveGapsOptions,
): ReferenceGap[] {
  const out: ReferenceGap[] = [];
  for (const metric of REFERENCE_GAP_METRICS) {
    let cur: Reading;
    let ref: Reading;
    if (metric === "section_contrast") {
      if (!opts?.currentPrev || !opts?.referencePrev) continue;
      cur = predecessorContrast(wrap(current.energy), wrap(opts.currentPrev.energy));
      ref = predecessorContrast(wrap(reference.features.energy), wrap(opts.referencePrev.features.energy));
    } else {
      cur = currentReading(current, metric);
      ref = referenceReading(reference, metric);
    }
    if (cur.value === undefined || ref.value === undefined) continue; // unknown — no gap

    const delta = ref.value - cur.value;
    const direction: ReferenceGap["direction"] =
      Math.abs(delta) < REFERENCE_GAP_EPSILON
        ? "similar"
        : delta > 0
          ? "higher_in_reference"
          : "lower_in_reference";

    const confs = [cur.confidence, ref.confidence, opts?.alignmentConfidence].filter(
      (x): x is number => x !== undefined,
    );
    out.push({
      metric,
      current: { value: cur.value, source: cur.source ?? "derived", ...(cur.confidence !== undefined ? { confidence: cur.confidence } : {}) },
      reference: { value: ref.value, source: ref.source ?? "derived", ...(ref.confidence !== undefined ? { confidence: ref.confidence } : {}) },
      delta: Math.round(delta * 1000) / 1000,
      direction,
      strength: Math.round(Math.min(1, Math.abs(delta) / STRENGTH_FULL_DELTA) * 1000) / 1000,
      ...(confs.length ? { confidence: Math.min(...confs) } : {}),
      currentSectionId: current.sectionId,
      referenceSectionId: reference.id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification — gap reduction as evidence, never "identical" as the bar
// ---------------------------------------------------------------------------

/**
 * Compare the before/after planning contexts of the SAME reference pairing:
 * for each metric measured on both sides, gapReduction = |before| − |after|.
 * satisfied means "moved toward the reference by at least
 * REFERENCE_GAP_REDUCTION_EPSILON" — afterGap === 0 is never required (§41).
 * A metric unmeasured on either side reads unknown, never a fabricated pass.
 */
export function verifyReferenceProgress(
  before: ReferencePlanningContext,
  after: ReferencePlanningContext,
): ReferenceVerification[] {
  const out: ReferenceVerification[] = [];
  const afterByMetric = new Map(after.gaps.map((g) => [g.metric, g]));
  for (const b of before.gaps) {
    const a = afterByMetric.get(b.metric);
    if (b.delta === undefined) continue;
    const confs = [b.confidence, a?.confidence].filter((x): x is number => x !== undefined);
    if (a?.delta === undefined) {
      out.push({
        metric: b.metric,
        beforeGap: b.delta,
        ...(confs.length ? { confidence: Math.min(...confs) } : {}),
      });
      continue;
    }
    const reduction = Math.abs(b.delta) - Math.abs(a.delta);
    out.push({
      metric: b.metric,
      beforeGap: b.delta,
      afterGap: a.delta,
      gapReduction: Math.round(reduction * 1000) / 1000,
      // Strictly greater: a reduction of exactly the epsilon (0.21 → 0.18)
      // is the boundary case §58 counts as NOT yet improved.
      satisfied: reduction > REFERENCE_GAP_REDUCTION_EPSILON,
      ...(confs.length ? { confidence: Math.min(...confs) } : {}),
    });
  }
  return out;
}
