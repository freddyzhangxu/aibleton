/**
 * music/features/track.ts — MusicState → TrackFeatures.
 *
 * Pure and deterministic. MIDI quantities come straight from the facts layer
 * (ClipState.material is already loop-windowed and mute-filtered by the
 * builder, so muted notes/clips/tracks can never leak in). Audio quantities
 * come from aggregateTrackAudio — the single producer of per-track source-
 * file aggregates (present.ts and goal/view.ts read the same numbers).
 *
 * The loop tile count (repetition) mirrors analysis/interpret.sectionEnergy's
 * formula exactly, so features count the same passes analysis heard.
 */

import { aggregateTrackAudio } from "../../analysis/interpret.js";
import type { MusicAnalysis, TrackRole } from "../../analysis/types.js";
import type { MusicState, TrackState } from "../../musicstate/types.js";
import { fv, normRange, ONSETS_PER_BAR_FULL } from "./normalize.js";
import type { TrackFeatures } from "./types.js";

/** Same integer-pass tiling as interpret.sectionEnergy: how many loop passes
 * of this clip actually sound. */
function tileCount(clipDuration: number, loopLen: number): number {
  return Math.max(1, Math.ceil(clipDuration / Math.max(loopLen, 1e-6) - 1e-6));
}

/** Union of [start, end) spans, in beats. */
function unionBeats(spans: [number, number][]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curS, curE] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > curE) {
      total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  return total + (curE - curS);
}

function trackFeatures(
  ts: TrackState,
  state: MusicState,
  role: TrackRole | undefined,
  secPerBeat: number,
): TrackFeatures {
  const { barBeats } = state;
  const arrEnd = state.arrangement.endBeat;
  const m = ts.measurements; // null when muted, or no material at all
  const hasMidi = !ts.muted && m !== null && m.materialCount > 0;

  // Union of the track's audible arrangement clip spans.
  const spans: [number, number][] = [];
  if (!ts.muted) {
    for (const cs of ts.clips) {
      const c = cs.clip;
      if (c.start === null || c.muted) continue;
      const audible =
        c.kind === "midi" ? cs.material.length > 0 : Math.max(0, c.duration) > 0;
      if (!audible) continue;
      spans.push([c.start, c.start + Math.max(0, c.duration)]);
    }
  }
  const activeRatio = arrEnd > 0 ? Math.min(1, unionBeats(spans) / arrEnd) : 0;

  // Repetition: onsets produced by repeat passes ÷ all audible onsets.
  // Onsets are counted with the final partial pass truncated at the clip end
  // (same rule as section.ts) — a 4-beat loop over a 10-beat clip sounds
  // 2.5 passes, matching MusicState's fractional `repeats`, not ceil tiles.
  let repetition: number | undefined;
  {
    let total = 0;
    let singlePass = 0;
    if (!ts.muted) {
      for (const cs of ts.clips) {
        const c = cs.clip;
        if (c.start === null || c.muted || c.kind !== "midi") continue;
        if (cs.material.length === 0) continue;
        const dur = Math.max(0, c.duration);
        const passes = tileCount(dur, cs.window.loopLen);
        for (let k = 0; k < passes; k++) {
          for (const n of cs.material) {
            const rel = n.start - cs.window.winStart + k * cs.window.loopLen;
            if (rel < dur - 1e-6) total++;
          }
        }
        singlePass += cs.material.length;
      }
    }
    if (total > 0) repetition = (total - singlePass) / total;
  }

  // Audio source-file aggregate (single producer — never re-aggregate here).
  const audio = aggregateTrackAudio(ts, secPerBeat);

  // Analysis coverage: share of the track's audible arrangement audio (in
  // beats) that actually has features. < 1 = budget-skipped or failed clips
  // — surfaces as `confidence` on the audio-sourced fields.
  let audioCoverage: number | undefined;
  if (audio && !ts.muted) {
    let totalBeats = 0;
    let coveredBeats = 0;
    for (const cs of ts.clips) {
      const c = cs.clip;
      if (c.kind !== "audio" || c.start === null || c.muted) continue;
      const d = Math.max(0, c.duration);
      if (d <= 0) continue;
      totalBeats += d;
      if (cs.audio?.features) coveredBeats += d;
    }
    if (totalBeats > 0) audioCoverage = Math.min(1, coveredBeats / totalBeats);
  }

  // Rhythmic activity: MIDI onsets when the track has notes; otherwise
  // source-file transients converted to onsets/bar via tempo.
  const secPerBar = secPerBeat * barBeats;
  let rhythmicActivity: TrackFeatures["rhythmicActivity"];
  if (hasMidi && m) {
    const onsetsPerBar = m.audibleNotes / Math.max(1e-9, m.spanAudible / barBeats);
    rhythmicActivity = fv(normRange(onsetsPerBar, 0, ONSETS_PER_BAR_FULL), "midi");
  } else if (audio?.transientDensity !== undefined) {
    rhythmicActivity = fv(
      normRange(audio.transientDensity * secPerBar, 0, ONSETS_PER_BAR_FULL),
      "audio",
      audioCoverage,
    );
  }

  return {
    trackId: String(ts.track.index),
    name: ts.track.name,
    muted: ts.muted,
    ...(role !== undefined ? { role } : {}),
    ...(hasMidi && m
      ? {
          density: m.audibleNotes / Math.max(1e-9, m.spanAudible / barBeats),
          pitchRange: m.pitchMax - m.pitchMin,
          velocityRange: m.velMax - m.velMin,
        }
      : {}),
    ...(repetition !== undefined ? { repetition, variation: 1 - repetition } : {}),
    activeRatio,
    ...(rhythmicActivity !== undefined ? { rhythmicActivity } : {}),
    ...(audio
      ? {
          lowEnergy: fv(audio.bands.sub + audio.bands.bass, "audio", audioCoverage),
          midEnergy: fv(audio.bands.lowMid + audio.bands.mid, "audio", audioCoverage),
          highEnergy: fv(audio.bands.highMid + audio.bands.high, "audio", audioCoverage),
          ...(audio.transientDensity !== undefined
            ? { transientDensity: fv(audio.transientDensity, "audio", audioCoverage) }
            : {}),
        }
      : {}),
  };
}

/** TrackFeatures for every track in state order. `analysis` is optional
 * enrichment (role labels only) — features never require it. */
export function buildTrackFeatures(
  state: MusicState,
  analysis?: MusicAnalysis,
): TrackFeatures[] {
  const tempo = state.snapshot.tempo > 0 ? state.snapshot.tempo : 120;
  const secPerBeat = 60 / tempo;
  const roles = new Map<number, TrackRole>();
  if (analysis) for (const r of analysis.trackRoles) roles.set(r.i, r.role);
  return state.tracks.map((ts) =>
    trackFeatures(ts, state, roles.get(ts.track.index), secPerBeat),
  );
}
