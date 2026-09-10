/**
 * music/intelligence/types.ts — public structures of the Music Intelligence
 * layer: the chained layers as one object, plus its goal projection.
 *
 * Layer position:
 *
 *   MusicState → MusicalFeatures → MusicalRelationships → MusicalReasoning
 *              → CreativeActions
 *              → MusicIntelligence (the chain, one import site)
 *              → GoalMusicContext (the slice a declared goal needs)
 *              → Agent (set_goal's tool result — the planner's input)
 *
 * Rules (enforced by construction, not convention):
 * - Pure: MusicState + MusicGoal in, context out. No Live SDK, no server,
 *   no model, no I/O.
 * - Deterministic: same inputs → identical projection, every run.
 * - Honest: the honesty rules of features/relationships/reasoning hold here
 *   unchanged — undefined stays undefined, nothing is invented. The
 *   projection only SELECTS and RENDERS what the lower layers computed.
 */

import type {
  MusicalFeatures,
  SectionFeatures,
  SongFeatures,
  TrackFeatures,
} from "../features/types.js";
import type {
  ArrangementArc,
  MusicalRelationships,
  SectionContrast,
  SectionSimilarity,
} from "../relationships/types.js";
import type { MusicalObservation, MusicalReasoning } from "../reasoning/types.js";
import type { CreativeAction, CreativeActionSet } from "../actions/types.js";

// ---------------------------------------------------------------------------
// The chain container
// ---------------------------------------------------------------------------

/** The four layers chained — the full intelligence surface of one state. */
export interface MusicIntelligence {
  features: MusicalFeatures;
  relationships: MusicalRelationships;
  reasoning: MusicalReasoning;
  /** Candidate musical interventions derived from the reasoning (PR14) —
   * semantic hints for the planner, never commands. */
  actions: CreativeActionSet;
}

// ---------------------------------------------------------------------------
// Goal projection
// ---------------------------------------------------------------------------

/** How wide the projection reached — drives the presenter's shape. */
export type ProjectionScope =
  /** At least one focus term resolved — sections/tracks carry the matched
   * rows, relationships/observations are filtered to them. */
  | "focused"
  /** No focus term resolved (global goal, or every name missed) — sections/
   * tracks are empty; song + arc + top observations are the context. */
  | "song";

/**
 * The goal-relevant slice of a MusicIntelligence. Everything here is a
 * reference into the source layers — the projection copies nothing and
 * recomputes nothing.
 */
export interface GoalMusicContext {
  scope: ProjectionScope;
  /** The goal's declared target, echoed back. */
  target: { track?: string; section?: string };

  /** Matched sections, in arrangement order (focus matches plus repetition
   * partners pulled in so a "Drop 2" goal sees "Drop 1"). */
  sections: SectionFeatures[];
  /** Matched tracks (by name and by role), in track order. */
  tracks: TrackFeatures[];

  /** Contrasts with either end in scope (Build→Drop tension), order kept. */
  contrasts: SectionContrast[];
  /** Repeat/similar pairs with both ends in scope, order kept. */
  similarities: SectionSimilarity[];

  /** Whole-song context — always present (cheap, and a section's numbers
   * read differently against the song's range). */
  arc: ArrangementArc;
  song: SongFeatures;

  /** Observations touching the scope, ranked by strength × (confidence ?? 1),
   * ties broken by emission order; capped (see goal.ts). In song scope: the
   * global top-N. */
  observations: MusicalObservation[];
  coverage: MusicalReasoning["coverage"];

  /** Creative actions touching the scope (song-scope actions ride every
   * projection), in the action layer's own ranked order; capped like
   * observations. Candidate directions, not instructions. */
  actions: CreativeAction[];

  /** Focus terms that resolved to nothing (the select.ts echo pattern). */
  unmatched: string[];
}
