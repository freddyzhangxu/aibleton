/**
 * music/reasoning/track.ts — track/role co-activity observations.
 *
 * Deliberately narrow scope: PR12 ships no track↔track relationships, so
 * everything here reads features.tracks[] directly — and TrackFeatures are
 * ARRANGEMENT-LEVEL (activeRatio is the union of a track's audible spans
 * over the whole song, not per-section). These observations therefore state
 * global co-presence facts ONLY; nothing here claims two tracks sound
 * together in any specific section.
 *
 * Two kinds, both gated on the interpretation layer's role labels (present
 * only when buildMusicalFeatures was given the MusicAnalysis):
 *
 * - strong_rhythmic_foundation: a kick-like track (role "kick" or "drums")
 *   and a bass track both present for ≥ FOUNDATION_ACTIVE_RATIO of the
 *   arrangement.
 * - low_frequency_co_activity: that same pair, both with ANALYZED strong
 *   low end and both present ≥ CO_ACTIVITY_ACTIVE_RATIO. This is spectral
 *   co-activity of source files — NOT a masking verdict. Without post-mix
 *   audio feedback there is no evidence for "kick and bass clash", and this
 *   layer never says so.
 *
 * One pair max: the first kick-like and first bass track in track order.
 */

import type { TrackRole } from "../../analysis/types.js";
import type { MusicalFeatures } from "../features/types.js";
import type { MusicalObservation } from "./types.js";

/** Both tracks must be audible for at least this share of the arrangement
 * to read as a foundation. */
export const FOUNDATION_ACTIVE_RATIO = 0.8;
/** lowEnergy (spectral sub+bass share) at/above which a track's low end
 * counts as strong. */
export const LOW_ENERGY_CO_ACTIVITY = 0.5;
/** Co-presence gate for co-activity: below this the two tracks barely share
 * the arrangement and "co-activity" would be a fiction. */
export const CO_ACTIVITY_ACTIVE_RATIO = 0.5;

const KICK_ROLES: readonly TrackRole[] = ["kick", "drums"];

/** min of the defined confidences; undefined when neither carries one. */
function minConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function buildTrackObservations(features: MusicalFeatures): MusicalObservation[] {
  const out: MusicalObservation[] = [];
  const labeled = features.tracks.filter((t) => !t.muted && t.role !== undefined);
  const kick = labeled.find((t) => KICK_ROLES.includes(t.role as TrackRole));
  const bass = labeled.find((t) => t.role === "bass");
  if (kick === undefined || bass === undefined) return out;

  const ref = { trackId: kick.trackId, relatedTrackId: bass.trackId };

  if (
    kick.activeRatio >= FOUNDATION_ACTIVE_RATIO &&
    bass.activeRatio >= FOUNDATION_ACTIVE_RATIO
  ) {
    out.push({
      kind: "strong_rhythmic_foundation",
      ...ref,
      // strength = weakest participation share (0.8 gate → ≥ 0.8).
      strength: Math.min(kick.activeRatio, bass.activeRatio),
      evidence: [
        {
          metric: `tracks[${kick.trackId}].activeRatio`,
          value: kick.activeRatio,
          relatedValue: bass.activeRatio,
        },
      ],
    });
  }

  if (
    kick.lowEnergy !== undefined &&
    bass.lowEnergy !== undefined &&
    kick.lowEnergy.value >= LOW_ENERGY_CO_ACTIVITY &&
    bass.lowEnergy.value >= LOW_ENERGY_CO_ACTIVITY &&
    kick.activeRatio >= CO_ACTIVITY_ACTIVE_RATIO &&
    bass.activeRatio >= CO_ACTIVITY_ACTIVE_RATIO
  ) {
    const confidence = minConfidence(kick.lowEnergy.confidence, bass.lowEnergy.confidence);
    out.push({
      kind: "low_frequency_co_activity",
      ...ref,
      // strength = the weaker of the two low ends.
      strength: Math.min(kick.lowEnergy.value, bass.lowEnergy.value),
      ...(confidence !== undefined ? { confidence } : {}),
      evidence: [
        {
          metric: `tracks[${kick.trackId}].lowEnergy`,
          value: kick.lowEnergy.value,
          relatedValue: bass.lowEnergy.value,
        },
        {
          metric: `tracks[${kick.trackId}].activeRatio`,
          value: kick.activeRatio,
          relatedValue: bass.activeRatio,
        },
      ],
    });
  }

  return out;
}
