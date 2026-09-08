/**
 * analysis/index.ts — the interpretation stack, one import site.
 *
 * Pipeline (each stage also usable on its own):
 *
 *   SongSnapshot → buildMusicState → MusicState      (musicstate/ — what is)
 *   MusicState   → analyzeMusicState → MusicAnalysis (interpret — what it means)
 *   (state, ma, focus) → selectMusicContext          (select — what matters now)
 *   MusicAnalysis → presentAnalysis → SongAnalysis   (present — model-bound JSON)
 *
 * analyzeSong() composes all stages for consumers with no use for the
 * intermediates (move_analyze_set, offline fixture tests).
 */

import { buildMusicState } from "../musicstate/builder.js";
import type { SongSnapshot } from "../musicstate/types.js";
import { analyzeMusicState } from "./interpret.js";
import { presentAnalysis } from "./present.js";
import { selectMusicContext } from "./select.js";
import type { SongAnalysis } from "./types.js";

export { analyzeMusicState } from "./interpret.js";
export { presentAnalysis } from "./present.js";
export { focusTracksPerSection, selectMusicContext } from "./select.js";
export type { ContextSelection } from "./select.js";
export type {
  ClipEntry,
  FocusEcho,
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
 * analyze_song calls the stages explicitly instead (to thread focus through).
 * focus: same semantics as analyze_song's parameter — omitted = full read. */
export function analyzeSong(
  input: SongSnapshot,
  budget: number | null = 5800,
  focus?: string,
): SongAnalysis {
  const state = buildMusicState(input);
  const ma = analyzeMusicState(state);
  return presentAnalysis(
    state,
    ma,
    budget,
    focus?.trim() ? selectMusicContext(state, ma, focus.trim()) : undefined,
  );
}
