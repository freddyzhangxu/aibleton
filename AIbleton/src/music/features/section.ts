/**
 * music/features/section.ts — MusicState → SectionFeatures.
 *
 * Section boundaries come from analysis/interpret.sectionize (single
 * producer — cue points when present, fixed-size blocks otherwise); this
 * module never re-invents section detection.
 *
 * The MIDI onset pass mirrors interpret.sectionEnergy's tiling and section-
 * membership math exactly, so a feature's onset count is always the number
 * analysis heard. The audio pass aggregates the source-file features of the
 * clips OVERLAPPING each section, using the same weighting discipline as
 * interpret.aggregateTrackAudio: bands/centroid energy-weighted (seconds ×
 * 10^(rmsDb/10)), loudness/dynamicRange/transients duration-weighted with
 * undefined propagated (missing means "no data", never 0).
 *
 * impact / tension / release / energy are heuristic proxies — see types.ts.
 */

import { sectionize } from "../../analysis/interpret.js";
import type { AudioFeatures } from "../../dsp.js";
import type { MusicState } from "../../musicstate/types.js";
import {
  BRIGHTNESS_HZ_HI,
  BRIGHTNESS_HZ_LO,
  fv,
  LOUDNESS_DB_HI,
  LOUDNESS_DB_LO,
  normLog,
  normRange,
  ONSETS_PER_BAR_FULL,
  weightedMean,
  type WeightedComponent,
} from "./normalize.js";
import type { FeatureValue, SectionFeatures } from "./types.js";

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Per-section MIDI pass
// ---------------------------------------------------------------------------

interface SectionMidi {
  onsets: number;
  trackIdx: Set<number>;
  /** repetition parts: total onsets and how many of them came from repeats */
  repeated: number;
  velSum: number;
}

function emptyMidi(): SectionMidi {
  return { onsets: 0, trackIdx: new Set(), repeated: 0, velSum: 0 };
}

/**
 * Onset pass over one section — same loop structure, tile count, onset math
 * and 1e-6 membership window as interpret.sectionEnergy, with ONE deliberate
 * refinement: the final partial loop pass is truncated at the clip's
 * arrangement end. sectionEnergy counts full ceil tiles (a 4-beat loop over
 * a 10-beat clip reads 3 passes = 12 onsets); MusicState's audibleNotes uses
 * fractional repeats (2.5 → 10). Features follow MusicState — a note sounds
 * only when its onset falls inside the clip's span. For exact-multiple loops
 * the two agree, which is what the test-6 cross-check pins.
 */
function collectSectionMidi(
  state: MusicState,
  startBeat: number,
  endBeat: number,
): SectionMidi {
  const out = emptyMidi();
  for (const ts of state.tracks) {
    if (ts.muted) continue;
    for (const cs of ts.clips) {
      const { clip, window: win, material } = cs;
      if (clip.start === null || clip.muted || clip.kind !== "midi") continue;
      if (material.length === 0) continue;
      const clipEnd = clip.start + Math.max(0, clip.duration);
      const tiles = Math.max(1, Math.ceil(clip.duration / Math.max(win.loopLen, EPS) - EPS));
      let onsetsInSection = 0;
      let passesInSection = 0;
      for (let k = 0; k < tiles; k++) {
        let passOnsets = 0;
        for (const n of material) {
          const onset = clip.start + (n.start - win.winStart) + k * win.loopLen;
          if (onset >= clipEnd - EPS) continue; // truncated final pass
          if (onset >= startBeat - EPS && onset < endBeat - EPS) {
            passOnsets++;
            out.velSum += n.velocity;
          }
        }
        if (passOnsets > 0) {
          passesInSection++;
          onsetsInSection += passOnsets;
        }
      }
      if (onsetsInSection > 0) {
        out.onsets += onsetsInSection;
        out.trackIdx.add(ts.track.index);
        // Onsets beyond one representative pass are repeats of the same
        // material. Boundary-straddling passes make this approximate —
        // documented heuristic, not a measurement.
        out.repeated += (onsetsInSection * (passesInSection - 1)) / passesInSection;
      }
    }
  }
  return out;
}

/** Tracks whose unmuted audio clips sound in the section (analysis or not —
 * a clip occupying time is audible material). Merged with the MIDI onset
 * tracks for activeTrackRatio. */
function activeAudioTrackIdx(
  state: MusicState,
  startBeat: number,
  endBeat: number,
): Set<number> {
  const out = new Set<number>();
  for (const ts of state.tracks) {
    if (ts.muted) continue;
    for (const cs of ts.clips) {
      const c = cs.clip;
      if (c.kind !== "audio" || c.start === null || c.muted) continue;
      if (Math.max(0, c.duration) <= 0) continue;
      const overlap = Math.min(c.start + c.duration, endBeat) - Math.max(c.start, startBeat);
      if (overlap > EPS) {
        out.add(ts.track.index);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-section audio pass
// ---------------------------------------------------------------------------

interface SectionAudio {
  loudnessDb: number; // duration-weighted
  bands: { sub: number; bass: number; lowMid: number; mid: number; highMid: number; high: number };
  spectralCentroidHz: number; // energy-weighted
  dynamicRangeDb?: number; // duration-weighted, undefined-propagated
  transientDensity?: number; // duration-weighted, undefined-propagated
  /** Fraction of the section's audible audio (overlap beats) that actually
   * has features — 1 = every overlapping clip analyzed; < 1 = partial
   * coverage (budget-skipped or failed files). Surfaces as `confidence` so
   * consumers can distrust a quarter-analyzed aggregate. */
  coverage: number;
}

/** Overlap-duration weighted aggregate of the analyzed audio clips touching
 * the section. null when nothing audible with features overlaps. */
function collectSectionAudio(
  state: MusicState,
  startBeat: number,
  endBeat: number,
  secPerBeat: number,
): SectionAudio | null {
  const contributors: { f: AudioFeatures; wd: number; we: number }[] = [];
  let totalOverlap = 0;
  for (const ts of state.tracks) {
    if (ts.muted) continue;
    for (const cs of ts.clips) {
      const c = cs.clip;
      if (c.kind !== "audio" || c.start === null || c.muted) continue;
      if (Math.max(0, c.duration) <= 0) continue;
      const overlap = Math.min(c.start + Math.max(0, c.duration), endBeat) - Math.max(c.start, startBeat);
      if (overlap <= EPS) continue;
      totalOverlap += overlap;
      const f = cs.audio?.features;
      if (!f) continue; // includes cs.audio.error — failed files contribute nothing
      const wd = overlap * secPerBeat;
      contributors.push({ f, wd, we: wd * 10 ** (f.rmsDb / 10) });
    }
  }
  if (contributors.length === 0) return null;
  const coveredOverlap = contributors.reduce((a, c) => a + c.wd, 0) / secPerBeat;
  const coverage = totalOverlap > 0 ? Math.min(1, coveredOverlap / totalOverlap) : 1;

  let totalWd = 0;
  let totalWe = 0;
  for (const c of contributors) {
    totalWd += c.wd;
    totalWe += c.we;
  }
  const dmean = (get: (f: AudioFeatures) => number): number =>
    contributors.reduce((a, c) => a + get(c.f) * c.wd, 0) / totalWd;
  const dmeanOpt = (get: (f: AudioFeatures) => number | undefined): number | undefined => {
    let sum = 0;
    let w = 0;
    for (const c of contributors) {
      const v = get(c.f);
      if (v !== undefined) {
        sum += v * c.wd;
        w += c.wd;
      }
    }
    return w > 0 ? sum / w : undefined;
  };
  // All-silent contributors fall back to duration weighting (same rule as
  // interpret.aggregateTrackAudio) so the numbers stay finite.
  const useEnergy = totalWe > 1e-9;
  const ew = useEnergy ? totalWe : totalWd;
  const emean = (get: (f: AudioFeatures) => number): number =>
    contributors.reduce((a, c) => a + get(c.f) * (useEnergy ? c.we : c.wd), 0) / ew;

  const dynamicRangeDb = dmeanOpt((f) => f.dynamicRangeDb);
  const transientDensity = dmeanOpt((f) => f.transientDensity);
  return {
    loudnessDb: dmean((f) => f.loudnessDb),
    bands: {
      sub: emean((f) => f.bands.sub),
      bass: emean((f) => f.bands.bass),
      lowMid: emean((f) => f.bands.lowMid),
      mid: emean((f) => f.bands.mid),
      highMid: emean((f) => f.bands.highMid),
      high: emean((f) => f.bands.high),
    },
    spectralCentroidHz: emean((f) => f.spectralCentroidHz),
    ...(dynamicRangeDb !== undefined ? { dynamicRangeDb } : {}),
    ...(transientDensity !== undefined ? { transientDensity } : {}),
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Derived proxies
// ---------------------------------------------------------------------------

function derived(
  components: WeightedComponent[],
): FeatureValue | undefined {
  const r = weightedMean(components);
  return r ? fv(r.value, "derived", r.coverage) : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildSectionFeatures(state: MusicState): SectionFeatures[] {
  const tempo = state.snapshot.tempo > 0 ? state.snapshot.tempo : 120;
  const secPerBeat = 60 / tempo;
  const secPerBar = secPerBeat * state.barBeats;
  // Zero-length sections (duplicate cue times produce [t, t)) carry no
  // onsets by construction; analysis's sectionEnergy skips them implicitly,
  // so features drop them explicitly to keep the two layers aligned.
  const raws = sectionize(state.snapshot, state.barBeats, state.arrangement.endBeat).filter(
    (r) => r.endBeat - r.startBeat > EPS,
  );

  // Denominator of activeTrackRatio: unmuted tracks with audible arrangement
  // material anywhere (MIDI notes, or an audio clip occupying time).
  let audibleTracks = 0;
  for (const ts of state.tracks) {
    if (ts.muted) continue;
    const hasAudible = ts.clips.some((cs) => {
      const c = cs.clip;
      if (c.start === null || c.muted) return false;
      return c.kind === "midi" ? cs.material.length > 0 : Math.max(0, c.duration) > 0;
    });
    if (hasAudible) audibleTracks++;
  }

  return raws.map((raw, i) => {
    const bars = (raw.endBeat - raw.startBeat) / state.barBeats;
    const midi = collectSectionMidi(state, raw.startBeat, raw.endBeat);
    const audio = collectSectionAudio(state, raw.startBeat, raw.endBeat, secPerBeat);

    // Active = MIDI onsets OR an audio clip sounding in this section.
    const audioActiveIdx = activeAudioTrackIdx(state, raw.startBeat, raw.endBeat);
    const activeIdx = midi.trackIdx;
    for (const i of audioActiveIdx) activeIdx.add(i);

    const density = midi.onsets / Math.max(1e-9, bars);
    const activeTrackRatio = audibleTracks > 0 ? activeIdx.size / audibleTracks : 0;
    const densityN = normRange(density, 0, ONSETS_PER_BAR_FULL);

    // Rhythmic activity: MIDI onsets when the section has notes; otherwise
    // source-file transients of the overlapping audio clips.
    let rhythmicActivity: FeatureValue | undefined;
    if (midi.onsets > 0) {
      rhythmicActivity = fv(densityN, "midi");
    } else if (audio?.transientDensity !== undefined) {
      rhythmicActivity = fv(
        normRange(audio.transientDensity * secPerBar, 0, ONSETS_PER_BAR_FULL),
        "audio",
        audio.coverage,
      );
    }

    // --- energy family ---
    // energyMidi is a fact-based proxy: 0 means genuinely no MIDI activity.
    // EXCEPTION: in a section with active audio but no notes, MIDI silence is
    // not evidence — the proxy has no jurisdiction and stays undefined
    // (otherwise unanalyzed audio-only sections would read a fake ~0.33).
    const hasAudioActivity = audioActiveIdx.size > 0;
    let energyMidi: FeatureValue | undefined;
    if (!(midi.onsets === 0 && hasAudioActivity)) {
      const r = weightedMean([
        { v: densityN, w: 0.5 },
        { v: activeTrackRatio, w: 0.25 },
        {
          v: midi.onsets > 0 ? midi.velSum / midi.onsets / 127 : undefined,
          w: 0.25,
        },
      ]);
      if (r) energyMidi = fv(r.value, "midi", r.coverage);
    }
    const energyAudio =
      audio !== null
        ? fv(
            normRange(audio.loudnessDb, LOUDNESS_DB_LO, LOUDNESS_DB_HI),
            "audio",
            audio.coverage,
          )
        : undefined;
    const energy = derived([
      { v: energyMidi?.value, w: 1 },
      { v: energyAudio?.value, w: 1 },
    ]);

    // --- heuristic proxies (components exactly as documented in types.ts) ---
    const transientN =
      audio?.transientDensity !== undefined
        ? normRange(audio.transientDensity * secPerBar, 0, ONSETS_PER_BAR_FULL)
        : undefined;
    const lowE = audio ? audio.bands.sub + audio.bands.bass : undefined;
    const midE = audio ? audio.bands.lowMid + audio.bands.mid : undefined;
    const highE = audio ? audio.bands.highMid + audio.bands.high : undefined;

    const impact = derived([
      { v: densityN, w: 0.25 },
      { v: activeTrackRatio, w: 0.2 },
      { v: transientN, w: 0.2 },
      { v: lowE, w: 0.2 },
      { v: highE, w: 0.15 },
    ]);
    // High-frequency component: band share preferred, brightness as fallback.
    const highFreq = highE ?? (audio ? normLog(audio.spectralCentroidHz, BRIGHTNESS_HZ_LO, BRIGHTNESS_HZ_HI) : undefined);
    const tension = derived([
      { v: highFreq, w: 0.5 },
      { v: rhythmicActivity?.value, w: 0.5 },
    ]);
    const release = derived([
      { v: 1 - densityN, w: 0.4 },
      { v: rhythmicActivity !== undefined ? 1 - rhythmicActivity.value : undefined, w: 0.3 },
      { v: highFreq !== undefined ? 1 - highFreq : undefined, w: 0.3 },
    ]);

    const repetition =
      midi.onsets > 0 ? midi.repeated / midi.onsets : undefined;

    return {
      sectionId: String(i),
      name: raw.name,
      startBeat: raw.startBeat,
      endBeat: raw.endBeat,
      bars,
      density,
      activeTrackRatio,
      ...(repetition !== undefined ? { repetition, variation: 1 - repetition } : {}),
      ...(rhythmicActivity !== undefined ? { rhythmicActivity } : {}),
      ...(audio
        ? {
            lowEnergy: fv(audio.bands.sub + audio.bands.bass, "audio", audio.coverage),
            midEnergy: fv(audio.bands.lowMid + audio.bands.mid, "audio", audio.coverage),
            highEnergy: fv(audio.bands.highMid + audio.bands.high, "audio", audio.coverage),
            spectralBrightness: fv(
              normLog(audio.spectralCentroidHz, BRIGHTNESS_HZ_LO, BRIGHTNESS_HZ_HI),
              "audio",
              audio.coverage,
            ),
            ...(audio.transientDensity !== undefined
              ? { transientDensity: fv(audio.transientDensity, "audio", audio.coverage) }
              : {}),
            ...(audio.dynamicRangeDb !== undefined
              ? { dynamicRange: fv(audio.dynamicRangeDb, "audio", audio.coverage) }
              : {}),
          }
        : {}),
      ...(energyMidi !== undefined ? { energyMidi } : {}),
      ...(energyAudio !== undefined ? { energyAudio } : {}),
      ...(energy !== undefined ? { energy } : {}),
      ...(impact !== undefined ? { impact } : {}),
      ...(tension !== undefined ? { tension } : {}),
      ...(release !== undefined ? { release } : {}),
    };
  });
}
