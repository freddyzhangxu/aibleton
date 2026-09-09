/**
 * music/features/index.ts — the Musical Feature Model, one import site.
 *
 *   MusicState → buildMusicalFeatures → MusicalFeatures
 *
 * Pure, deterministic, no LLM, read-only (see types.ts for the rules and the
 * two honesty rules: undefined = "no data", and impact/tension/release are
 * confidence-carrying proxies, not truth).
 *
 * `analysis` is optional enrichment: when the caller already ran the
 * interpretation layer, track features pick up role labels. Features never
 * require it and never invoke it.
 */

import type { MusicAnalysis } from "../../analysis/types.js";
import type { MusicState } from "../../musicstate/types.js";
import { buildSectionFeatures } from "./section.js";
import { buildSongFeatures } from "./song.js";
import { buildTrackFeatures } from "./track.js";
import type { MusicalFeatures } from "./types.js";

export { buildSectionFeatures } from "./section.js";
export { buildSongFeatures } from "./song.js";
export { buildTrackFeatures } from "./track.js";
export {
  BRIGHTNESS_HZ_HI,
  BRIGHTNESS_HZ_LO,
  clamp01,
  LOUDNESS_DB_HI,
  LOUDNESS_DB_LO,
  normLog,
  normOpt,
  normRange,
  ONSETS_PER_BAR_FULL,
  weightedMean,
} from "./normalize.js";
export type {
  FeatureSource,
  FeatureValue,
  MusicalFeatures,
  SectionFeatures,
  SongFeatures,
  TrackFeatures,
} from "./types.js";

export function buildMusicalFeatures(
  state: MusicState,
  analysis?: MusicAnalysis,
): MusicalFeatures {
  const tracks = buildTrackFeatures(state, analysis);
  const sections = buildSectionFeatures(state);
  const song = buildSongFeatures(state, sections);
  return { song, sections, tracks };
}
