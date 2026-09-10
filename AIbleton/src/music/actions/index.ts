/**
 * music/actions/index.ts — the Creative Action Library, one import site.
 *
 *   MusicalReasoning → deriveCreativeActions → CreativeActionSet
 *
 * PR14 scope: translate evidence-backed musical observations (PR13) into a
 * compact, closed vocabulary of CANDIDATE musical interventions. Semantic,
 * non-executable, goal-independent: actions never call Live, never choose
 * tools, never claim to be necessary — the Planner consumes them as
 * planning hints and the LLM/user keeps creative judgement. Pure,
 * deterministic, read-only; the honesty rules of PR11–PR13 hold unchanged
 * (unknown stays unknown; directional observations are never inverted into
 * corrections). See types.ts for the layer contract.
 */

import type { MusicalReasoning } from "../reasoning/types.js";
import { deriveCandidates } from "./derive.js";
import { OBSERVATION_MAPPINGS } from "./mappings.js";
import { mergeCreativeActions, resolveConflicts } from "./merge.js";
import { MAX_CREATIVE_ACTIONS, rankCreativeActions } from "./rank.js";
import type { CreativeActionSet } from "./types.js";

export { deriveCandidates } from "./derive.js";
export {
  LOW_STRENGTH_FACTOR,
  KIND_DIMENSION,
  OBSERVATION_MAPPINGS,
  OPPOSITE_ACTIONS,
  OPPOSITION_TIE_EPS,
  SUBORDINATE_ACTIONS,
} from "./mappings.js";
export type { CandidateSpec } from "./mappings.js";
export { mergeCreativeActions, resolveConflicts } from "./merge.js";
export { MAX_CREATIVE_ACTIONS, rankCreativeActions } from "./rank.js";
export { CREATIVE_ACTION_KINDS } from "./types.js";
export type {
  CreativeAction,
  CreativeActionKind,
  CreativeActionSet,
  CreativeActionTarget,
  CreativeDimension,
} from "./types.js";

export function deriveCreativeActions(reasoning: MusicalReasoning): CreativeActionSet {
  const raw = deriveCandidates(reasoning);
  const merged = mergeCreativeActions(raw);
  const resolved = resolveConflicts(merged);
  const ranked = rankCreativeActions(resolved);
  return {
    actions: ranked.slice(0, MAX_CREATIVE_ACTIONS),
    coverage: {
      sourceObservations: reasoning.observations.length,
      actionableObservations: reasoning.observations.filter(
        (o) => OBSERVATION_MAPPINGS[o.kind] !== undefined,
      ).length,
    },
  };
}
