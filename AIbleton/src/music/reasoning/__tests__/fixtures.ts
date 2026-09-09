/**
 * PR13 test fixtures: reuse the relationships layer's builders (single
 * producer) and add only what reasoning needs on top — a velocity-contrast
 * song for evolution detection and a minimal MusicAnalysis for role labels.
 */

import type { MusicAnalysis, TrackRole } from "../../../analysis/types.js";
import { buildMusicalFeatures } from "../../features/index.js";
import { buildMusicalRelationships } from "../../relationships/index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import type { MusicalFeatures } from "../../features/types.js";
import type { MusicalRelationships } from "../../relationships/types.js";
import {
  fourOnFloor,
  midiClip,
  snapshot,
  track,
} from "../../features/__tests__/fixtures.js";

export {
  audioClip,
  audioFeatures,
  densityShapeSong,
  fourOnFloor,
  midiClip,
  note,
  snapshot,
  stateWithAudio,
  track,
} from "../../relationships/__tests__/fixtures.js";

export function relate(features: MusicalFeatures): MusicalRelationships {
  return buildMusicalRelationships(features);
}

/** Two identical 8-bar sections differing ONLY in note velocity — similarity
 * reads "repeat" (velocity is not a similarity dimension) while energy
 * moves, the canonical repeated_section_with_evolution input. */
export function velocityEvolutionSong(velA: number, velB: number): MusicalFeatures {
  const sectionBeats = 8 * 4;
  const notes = (v: number) => fourOnFloor(8).map((n) => ({ ...n, velocity: v }));
  return buildMusicalFeatures(
    buildMusicState(
      snapshot(
        [
          track(0, "Keys", "midi", [
            midiClip("a", notes(velA), { start: 0, duration: sectionBeats }),
            midiClip("b", notes(velB), { start: sectionBeats, duration: sectionBeats }),
          ]),
        ],
        {
          cuePoints: [
            { time: 0, name: "A" },
            { time: sectionBeats, name: "B" },
          ],
        },
      ),
    ),
  );
}

/** Minimal MusicAnalysis carrying only what features consume: role labels. */
export function rolesOf(...roles: [number, TrackRole][]): MusicAnalysis {
  return {
    key: { status: "insufficient_material" },
    sections: [],
    trackRoles: roles.map(([i, role]) => ({ i, role, isDrums: role === "kick" || role === "drums" })),
    issues: [],
  };
}
