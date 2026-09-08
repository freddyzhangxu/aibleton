/**
 * goal/view.ts — GoalView: the measurement surface goal criteria judge against.
 *
 * Built twice per goal turn: once when set_goal is declared (baseline) and
 * once when the model stops calling tools (after). Everything here is derived
 * from MusicState + the interpretation layer (analysis.ts) with budget cuts
 * OFF — a section lost to fitBudget could never be evaluated.
 *
 * Section role attribution walks audible onsets per track (same tiling math
 * as analysis.ts's sectionEnergy) and maps them into section beat ranges
 * recovered from SectionInfo.bars. Cue-aligned boundaries are bar-rounded
 * here, so an onset within half a beat of a cue can land one section over —
 * acceptable for role presence, which is all this walk feeds.
 */

import { analyzeMusicState } from "../analysis.js";
import type { MusicState } from "../musicstate/types.js";

export interface GoalTrackMeasure {
  name: string;
  role: string; // TrackRole
  notes: number; // audible arrangement notes incl. loop repeats
  muted: boolean;
}

export interface GoalSectionMeasure {
  name: string;
  bars: [number, number];
  notes: number; // onsets incl. loop repeats (from SectionInfo)
  density: number; // notes per bar
  tracks: number; // tracks with >= 1 onset (from SectionInfo)
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
  const analysis = analyzeMusicState(state, null);
  const barBeats = state.barBeats;

  const sections: GoalSectionMeasure[] = analysis.sections.map((s) => ({
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
    const role = analysis.tracks[i]?.role ?? "unknown";
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

  const tracks: GoalTrackMeasure[] = analysis.tracks.map((t) => ({
    name: t.name,
    role: t.role,
    notes: t.notes,
    muted: t.muted === true,
  }));

  return {
    tempo: analysis.tempo,
    keyBest: analysis.key.best,
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
