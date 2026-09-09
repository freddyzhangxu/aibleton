/**
 * goal/view.ts — GoalView: the measurement surface goal criteria judge against.
 *
 * Built twice per goal turn: once when set_goal is declared (baseline) and
 * once when the model stops calling tools (after). Everything here is derived
 * from MusicState + MusicAnalysis (analysis/) — the uncut interpretation
 * layer, so a section lost to fitBudget could never be evaluated.
 *
 * Section role attribution walks audible onsets per track (same tiling math
 * as interpret.ts's sectionEnergy) and maps them into section beat ranges
 * recovered from SectionAnalysis.bars. Cue-aligned boundaries are bar-rounded
 * here, so an onset within half a beat of a cue can land one section over —
 * acceptable for role presence, which is all this walk feeds.
 */

import { analyzeMusicState } from "../analysis/index.js";
import type { AudioBands } from "../dsp.js";
import type { MusicState } from "../musicstate/types.js";

export interface GoalTrackMeasure {
  name: string;
  role: string; // TrackRole
  notes: number; // audible arrangement notes incl. loop repeats
  muted: boolean;
  /** Source-file audio aggregate (interpret.ts's TrackAudioAnalysis) —
   * present only when audio enrichment ran for this view. */
  audio?: {
    crestDb: number;
    rmsDb: number;
    dynamicRangeDb?: number;
    bands: AudioBands;
  };
}

export interface GoalSectionMeasure {
  name: string;
  bars: [number, number];
  notes: number; // onsets incl. loop repeats (from SectionAnalysis)
  density: number; // notes per bar
  tracks: number; // tracks with >= 1 onset (from SectionAnalysis)
  roles: Set<string>; // roles audible in this section (the onset walk below)
}

export interface GoalView {
  tempo: number;
  keyBest: string | undefined; // analysis.key.best, undefined when undetectable
  trackCount: number;
  tracks: GoalTrackMeasure[];
  sections: GoalSectionMeasure[];
  songRoles: Set<string>; // roles audible anywhere (muted tracks excluded)
}

export function buildGoalView(state: MusicState): GoalView {
  const ma = analyzeMusicState(state);
  const barBeats = state.barBeats;

  const sections: GoalSectionMeasure[] = ma.sections.map((s) => ({
    name: s.name,
    bars: s.bars,
    notes: s.notes,
    density: s.notes / Math.max(1, s.bars[1] - s.bars[0] + 1),
    tracks: s.tracks,
    roles: new Set<string>(),
  }));
  // Beat ranges recovered from 1-based bar numbers (sectionize bar-aligns).
  const ranges = sections.map((s) => ({
    startBeat: (s.bars[0] - 1) * barBeats,
    endBeat: s.bars[1] * barBeats,
  }));

  // Attribute roles to sections: walk each track's audible arrangement onsets
  // exactly like sectionEnergy does (loop region tiled across the clip).
  state.tracks.forEach((ts, i) => {
    if (ts.muted) return;
    const role = ma.trackRoles[i]?.role ?? "unknown";
    for (const cs of ts.clips) {
      const { clip, window: win, material } = cs;
      if (clip.start === null || clip.muted || material.length === 0) continue;
      const tiles = Math.max(1, Math.ceil(clip.duration / Math.max(win.loopLen, 1e-6) - 1e-6));
      for (let k = 0; k < tiles; k++) {
        for (const n of material) {
          const onset = clip.start + (n.start - win.winStart) + k * win.loopLen;
          for (let s = 0; s < ranges.length; s++) {
            if (onset >= ranges[s].startBeat - 1e-6 && onset < ranges[s].endBeat - 1e-6) {
              sections[s].roles.add(role);
              break;
            }
          }
        }
      }
    }
  });

  const tracks: GoalTrackMeasure[] = state.tracks.map((ts, i) => {
    const a = ma.trackAudio?.[i];
    return {
      name: ts.track.name,
      role: ma.trackRoles[i]?.role ?? "unknown",
      notes: ts.measurements?.audibleNotes ?? 0,
      muted: ts.muted,
      ...(a
        ? {
            audio: {
              crestDb: a.crestDb,
              rmsDb: a.rmsDb,
              ...(a.dynamicRangeDb !== undefined ? { dynamicRangeDb: a.dynamicRangeDb } : {}),
              bands: a.bands,
            },
          }
        : {}),
    };
  });

  return {
    tempo: state.snapshot.tempo ?? 120,
    keyBest: ma.key.best,
    trackCount: tracks.length,
    tracks,
    sections,
    songRoles: new Set(tracks.filter((t) => !t.muted && t.notes > 0).map((t) => t.role)),
  };
}

/** Case-insensitive section lookup: exact first, then substring ("drop" finds
 * "Drop 2"). Returns undefined with the caller listing what exists. */
export function findSection(view: GoalView, name: string): GoalSectionMeasure | undefined {
  const norm = name.trim().toLowerCase();
  return (
    view.sections.find((s) => s.name.toLowerCase() === norm) ??
    view.sections.find((s) => s.name.toLowerCase().includes(norm))
  );
}
