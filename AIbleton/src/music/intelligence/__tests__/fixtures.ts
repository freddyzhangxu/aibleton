/**
 * PR13.5 test fixtures: reuse the reasoning layer's builders (single
 * producer) and add only what the intelligence layer needs — goal literals
 * and two canonical songs (Build→Drop contrast, Drop1↔Drop2 repeat).
 */

import type { MusicGoal } from "../../../goal/types.js";
import type { SongSnapshot } from "../../../musicstate/types.js";
import type { MusicIntelligence } from "../types.js";
import { buildMusicIntelligence } from "../index.js";
import { buildMusicState } from "../../../musicstate/builder.js";
import type { MusicAnalysis } from "../../../analysis/types.js";
import { midiClip, note, snapshot, track } from "../../features/__tests__/fixtures.js";
import { fourOnFloor } from "../../features/__tests__/fixtures.js";
import { sixteenthNotes } from "../../relationships/__tests__/fixtures.js";

export {
  densityShapeSong,
  fourOnFloor,
  midiClip,
  note,
  rolesOf,
  snapshot,
  track,
  velocityEvolutionSong,
} from "../../reasoning/__tests__/fixtures.js";
export { sixteenthNotes } from "../../relationships/__tests__/fixtures.js";

/** A MusicGoal literal — already normalized shape (the projection consumes
 * MusicGoal, not raw tool input). */
export function goalOf(over: Partial<MusicGoal> = {}): MusicGoal {
  return {
    type: over.type ?? "edit",
    ...(over.target ? { target: over.target } : {}),
    objective: over.objective ?? "test goal",
    constraints: over.constraints ?? [],
    successCriteria: over.successCriteria ?? [],
  };
}

/** Two 8-bar sections: "Build" (four-on-floor kick) → "Drop" (16ths kick +
 * bass enters). Track roles: Kick=kick, Bass=bass. */
export function buildDropSnapshot(): SongSnapshot {
  const sectionBeats = 8 * 4;
  return snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("k-build", fourOnFloor(1), { start: 0, duration: sectionBeats }),
        midiClip("k-drop", sixteenthNotes(1), { start: sectionBeats, duration: sectionBeats }),
      ]),
      track(1, "Bass", "midi", [
        midiClip("b-drop", fourOnFloor(1, 40), { start: sectionBeats, duration: sectionBeats }),
      ]),
    ],
    {
      cuePoints: [
        { time: 0, name: "Build" },
        { time: sectionBeats, name: "Drop" },
      ],
    },
  );
}

/** Snapshot → MusicIntelligence with kick/bass role labels. */
export function buildDropIntel(): MusicIntelligence {
  const state = buildMusicState(buildDropSnapshot());
  const analysis: MusicAnalysis = {
    key: { status: "insufficient_material" },
    sections: [],
    trackRoles: [
      { i: 0, role: "kick", isDrums: true },
      { i: 1, role: "bass", isDrums: false },
    ],
    issues: [],
  };
  return buildMusicIntelligence(state, analysis);
}

/** Three 8-bar sections "Drop 1" (16ths) / "Verse" (1 note/bar) / "Drop 2"
 * (16ths) — the two Drops are feature-identical, the canonical repeat pair
 * for partner pull-in. */
export function repeatSnapshot(): SongSnapshot {
  const sectionBeats = 8 * 4;
  return snapshot(
    [
      track(0, "Kick", "midi", [
        midiClip("d1", sixteenthNotes(1), { start: 0, duration: sectionBeats }),
        midiClip("v", [note(36, 0, 1)], { start: sectionBeats, duration: sectionBeats }),
        midiClip("d2", sixteenthNotes(1), { start: 2 * sectionBeats, duration: sectionBeats }),
      ]),
    ],
    {
      cuePoints: [
        { time: 0, name: "Drop 1" },
        { time: sectionBeats, name: "Verse" },
        { time: 2 * sectionBeats, name: "Drop 2" },
      ],
    },
  );
}

export function repeatIntel(): MusicIntelligence {
  return buildMusicIntelligence(buildMusicState(repeatSnapshot()));
}
