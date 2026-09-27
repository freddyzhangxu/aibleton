import type { AudioBands, VocalCues } from "../../dsp.js";

export interface VocalReading {
  durationSec: number;
  rmsDb: number;
  peakDb: number;
  dynamicRangeDb?: number;
  spectralCentroidHz: number;
  bands: AudioBands;
  vocalCues?: VocalCues;
  partial?: true;
}

export interface VocalMetricDelta {
  metric: string;
  recorded: number;
  reference: number;
  /** Recorded minus reference, in `unit`. */
  delta: number;
  unit: "dB" | "Hz" | "share" | "%";
}

export interface VocalCueDelta extends VocalMetricDelta {
  kind: "candidate";
}

export interface VocalComparison {
  recorded: VocalReading;
  reference: VocalReading;
  deltas: VocalMetricDelta[];
  cueDeltas: VocalCueDelta[];
  caveat: string;
}
