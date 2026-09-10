/**
 * music/intelligence/index.ts — the Music Intelligence layer, one import site.
 *
 *   MusicState → buildMusicIntelligence → MusicIntelligence
 *   MusicIntelligence + MusicGoal → projectGoalContext → GoalMusicContext
 *   GoalMusicContext → presentGoalContext → JSON-ready compact object
 *
 * PR13.5 scope: wire PR11–13 into the agent loop. The relay model declares a
 * goal via set_goal; the server answers with the baseline view AND the goal's
 * projected music context, so the plan the model writes next stands on
 * measured features, contrasts, repetition and evidence-backed observations
 * instead of guesswork. Pure, deterministic, no LLM, read-only.
 */

import { buildMusicalFeatures } from "../features/index.js";
import { buildMusicalRelationships } from "../relationships/index.js";
import { buildMusicalReasoning } from "../reasoning/index.js";
import { deriveCreativeActions } from "../actions/index.js";
import type { MusicState } from "../../musicstate/types.js";
import type { MusicAnalysis } from "../../analysis/types.js";
import type { MusicIntelligence } from "./types.js";

export {
  MAX_CONTEXT_OBSERVATIONS,
  MAX_SONG_OBSERVATIONS,
  collectGoalFocus,
  projectGoalContext,
} from "./goal.js";
export { CONTEXT_BUDGET, presentGoalContext } from "./present.js";
export type { GoalMusicContext, MusicIntelligence, ProjectionScope } from "./types.js";

/**
 * Chain the layers. `analysis` (optional) only adds track role labels
 * to features — the same contract as buildMusicalFeatures. Creative
 * actions ride the reasoning: derived once here, goal-projected later.
 */
export function buildMusicIntelligence(state: MusicState, analysis?: MusicAnalysis): MusicIntelligence {
  const features = buildMusicalFeatures(state, analysis);
  const relationships = buildMusicalRelationships(features);
  const reasoning = buildMusicalReasoning(features, relationships);
  const actions = deriveCreativeActions(reasoning);
  return { features, relationships, reasoning, actions };
}
