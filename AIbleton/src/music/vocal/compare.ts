import { AUDIO_BAND_NAMES, type AudioFeatures } from "../../dsp.js";
import type { VocalComparison, VocalCueDelta, VocalMetricDelta, VocalReading } from "./types.js";

const CAVEAT = "Source-file measurements are pre-warp, pre-gain and pre-device. Vocal cues are screening candidates, not diagnoses. No pitch or tuning accuracy has been measured; the differences do not establish which performance sounds better.";

function reading(features: AudioFeatures): VocalReading {
  return {
    durationSec: features.durationSec,
    rmsDb: features.rmsDb,
    peakDb: features.peakDb,
    ...(features.dynamicRangeDb !== undefined ? { dynamicRangeDb: features.dynamicRangeDb } : {}),
    spectralCentroidHz: features.spectralCentroidHz,
    bands: { ...features.bands },
    ...(features.vocalCues ? { vocalCues: { ...features.vocalCues } } : {}),
    ...(features.partial ? { partial: true as const } : {}),
  };
}

function addDelta(
  output: VocalMetricDelta[], metric: string, recorded: number | undefined,
  reference: number | undefined, unit: VocalMetricDelta["unit"],
): void {
  if (recorded === undefined || reference === undefined || !Number.isFinite(recorded) || !Number.isFinite(reference)) return;
  const delta = Math.round((recorded - reference) * 1000) / 1000;
  if (delta === 0) return;
  output.push({ metric, recorded, reference, delta, unit });
}

/** Compare source-file measurements only; no quality ranking or pitch inference. */
export function compareVocalFeatures(recorded: AudioFeatures, reference: AudioFeatures): VocalComparison {
  const deltas: VocalMetricDelta[] = [];
  addDelta(deltas, "rms", recorded.rmsDb, reference.rmsDb, "dB");
  addDelta(deltas, "peak", recorded.peakDb, reference.peakDb, "dB");
  addDelta(deltas, "dynamic_range", recorded.dynamicRangeDb, reference.dynamicRangeDb, "dB");
  addDelta(deltas, "spectral_centroid", recorded.spectralCentroidHz, reference.spectralCentroidHz, "Hz");
  for (const band of AUDIO_BAND_NAMES) {
    addDelta(deltas, `band_${band}`, recorded.bands[band], reference.bands[band], "share");
  }

  const cues: VocalMetricDelta[] = [];
  addDelta(cues, "near_full_scale_share", recorded.vocalCues?.nearFullScalePercent, reference.vocalCues?.nearFullScalePercent, "%");
  addDelta(cues, "active_range", recorded.vocalCues?.activeRangeDb, reference.vocalCues?.activeRangeDb, "dB");
  addDelta(cues, "sibilance_candidate_share", recorded.vocalCues?.sibilanceCandidatePercent, reference.vocalCues?.sibilanceCandidatePercent, "%");
  // lowBurstCount is a raw count; it is not comparable across different durations.
  const cueDeltas: VocalCueDelta[] = cues.map((cue) => ({ ...cue, kind: "candidate" }));
  return {
    recorded: reading(recorded),
    reference: reading(reference),
    deltas,
    cueDeltas,
    caveat: CAVEAT,
  };
}
