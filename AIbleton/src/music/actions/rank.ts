/**
 * music/actions/rank.ts — deterministic ordering and the candidate cap.
 *
 * A short, useful set beats a comprehensive one: the Planner reads these
 * as hints, and hint spam is noise. Ordering criteria, in priority order:
 *
 * 1. higher strength (the evidence presses harder)
 * 2. higher confidence — only when BOTH carry one (a missing confidence is
 *    unknown, not zero; it must never lose a comparison)
 * 3. more specific target (more defined id fields — a candidate pointing
 *    at section 5 vs 3 outranks one pointing at the song in general)
 * 4. original derivation order (the reasoning layer's fixed emission
 *    order, riding on Array.sort stability via the explicit index)
 * 5. action vocabulary order (CREATIVE_ACTION_KINDS position — the final,
 *    always-defined tie-breaker, so output never depends on engine
 *    internals)
 *
 * No LLM, no scoring weights, no fuzz.
 */

import { CREATIVE_ACTION_KINDS, type CreativeAction } from "./types.js";

/** The candidate cap — matches the bounded-agent-loop philosophy: the
 * planner gets the few strongest hints, never a wall of them. */
export const MAX_CREATIVE_ACTIONS = 8;

const VOCAB_ORDER: ReadonlyMap<CreativeAction["kind"], number> = new Map(
  CREATIVE_ACTION_KINDS.map((k, i) => [k, i]),
);

/** Number of defined id fields — "how precisely does this point?". */
function specificity(a: CreativeAction): number {
  const t = a.target;
  return (
    (t.sectionId !== undefined ? 1 : 0) +
    (t.relatedSectionId !== undefined ? 1 : 0) +
    (t.trackId !== undefined ? 1 : 0) +
    (t.relatedTrackId !== undefined ? 1 : 0)
  );
}

export function rankCreativeActions(actions: readonly CreativeAction[]): CreativeAction[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      if (x.a.strength !== y.a.strength) return y.a.strength - x.a.strength;
      if (x.a.confidence !== undefined && y.a.confidence !== undefined) {
        if (x.a.confidence !== y.a.confidence) return y.a.confidence - x.a.confidence;
      }
      const spec = specificity(y.a) - specificity(x.a);
      if (spec !== 0) return spec;
      if (x.i !== y.i) return x.i - y.i;
      return (VOCAB_ORDER.get(x.a.kind) ?? 0) - (VOCAB_ORDER.get(y.a.kind) ?? 0);
    })
    .map((e) => e.a);
}
