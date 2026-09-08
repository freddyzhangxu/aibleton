/**
 * analysis/index.ts — the interpretation stack, one import site.
 *
 * Pipeline (each stage also usable on its own):
 *
 *   SongSnapshot → buildMusicState → MusicState      (musicstate/ — what is)
 *   MusicState   → analyzeMusicState → MusicAnalysis (interpret — what it means)
 *   MusicAnalysis → presentAnalysis → SongAnalysis   (present — model-bound JSON)
 *
 * analyzeSong() composes all three for consumers with no use for the
 * intermediates (move_analyze_set, offline fixture tests).
 */

import { buildMusicState } from "../musicstate/builder.js";
import type { SongSnapshot } from "../musicstate/types.js";
import { analyzeMusicState } from "./interpret.js";
import { presentAnalysis } from "./present.js";
import type { SongAnalysis } from "./types.js";

export { analyzeMusicState } from "./interpret.js";
export { presentAnalysis } from "./present.js";
export type {
  ClipEntry,
  IssueCode,
  KeyAnalysis,
  MusicAnalysis,
  MusicIssue,
  MusicRecommendation,
  SectionAnalysis,
  SongAnalysis,
  TrackAnalysis,
  TrackRole,
  TrackRoleAnalysis,
} from "./types.js";

/** One-call wrapper: snapshot -> facts -> interpretation -> presentation.
 * analyze_song calls the three stages explicitly instead. */
export function analyzeSong(input: SongSnapshot, budget: number | null = 5800): SongAnalysis {
  const state = buildMusicState(input);
  return presentAnalysis(state, analyzeMusicState(state), budget);
}
