/**
 * music/features/song.ts — MusicState + SectionFeatures → SongFeatures.
 *
 * Global aggregates only; the interesting structure (energy curve, section
 * contrast, arrangement arc) is PR12's job and reads from sections[].
 */

import type { MusicState } from "../../musicstate/types.js";
import type { SectionFeatures, SongFeatures } from "./types.js";

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function buildSongFeatures(
  state: MusicState,
  sections: SectionFeatures[],
): SongFeatures {
  const tracks = state.snapshot.tracks;
  const energies = sections
    .map((s) => s.energy?.value)
    .filter((v): v is number => v !== undefined);
  const minEnergy = energies.length > 0 ? Math.min(...energies) : undefined;
  const maxEnergy = energies.length > 0 ? Math.max(...energies) : undefined;

  return {
    durationBeats: state.arrangement.endBeat,
    bars: state.arrangement.bars,
    trackCount: tracks.length,
    midiTrackCount: tracks.filter((t) => t.type === "midi").length,
    audioTrackCount: tracks.filter((t) => t.type === "audio").length,
    tempo: state.snapshot.tempo,
    sectionCount: sections.length,
    ...(sections.length > 0
      ? {
          avgDensity: mean(sections.map((s) => s.density)),
          avgActiveTrackRatio: mean(sections.map((s) => s.activeTrackRatio)),
        }
      : {}),
    ...(minEnergy !== undefined && maxEnergy !== undefined
      ? { minEnergy, maxEnergy, energyRange: maxEnergy - minEnergy }
      : {}),
  };
}
