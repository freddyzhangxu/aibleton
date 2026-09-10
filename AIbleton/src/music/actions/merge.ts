/**
 * music/actions/merge.ts — dedupe, subordination and opposition resolution.
 *
 * Three deterministic passes, each a pure list → list transform that never
 * reorders survivors:
 *
 * 1. DEDUPE — same kind + same target (scope + every id) collapses into one
 *    action: sourceObservations become the stable union (first-seen order,
 *    reference identity — every observation object appears at most once),
 *    strength takes the max (the strongest single piece of evidence carries
 *    the candidate), confidence takes the weakest link (min of the defined
 *    ones; undefined only when NO source carries one — never faked as 1).
 *
 * 2. SUBORDINATION — develop_section drops when introduce_variation exists
 *    for the SAME section pair: when the evidence specifically says low
 *    variation, the precise candidate wins over the vague one
 *    (SUBORDINATE_ACTIONS table in mappings.ts).
 *
 * 3. OPPOSITION — opposite kinds (OPPOSITE_ACTIONS) on the SAME target
 *    cannot both be surfaced: a clearly stronger candidate wins
 *    (|Δstrength| > OPPOSITION_TIE_EPS); an effective tie surfaces NEITHER.
 *    Ties are never broken by emission or lexical order — an arbitrary
 *    winner would be taste dressed up as logic.
 */

import { OPPOSITE_ACTIONS, OPPOSITION_TIE_EPS, SUBORDINATE_ACTIONS } from "./mappings.js";
import type { CreativeAction, CreativeActionTarget } from "./types.js";

/** Dedupe identity: kind + the whole target. */
function identityKey(a: CreativeAction): string {
  const t = a.target;
  return [a.kind, targetKey(t)].join(" ");
}

/** Conflict identity: the target alone (kind-agnostic). */
function targetKey(t: CreativeActionTarget): string {
  return [
    t.scope ?? "",
    t.sectionId ?? "",
    t.relatedSectionId ?? "",
    t.trackId ?? "",
    t.relatedTrackId ?? "",
  ].join(" ");
}

/** Section-pair identity for subordination. */
function pairKey(t: CreativeActionTarget): string {
  return `${t.sectionId ?? ""} ${t.relatedSectionId ?? ""}`;
}

/** min of the defined confidences; undefined when neither carries one. */
function minConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function mergeCreativeActions(raw: readonly CreativeAction[]): CreativeAction[] {
  const byKey = new Map<string, CreativeAction>();
  for (const a of raw) {
    const key = identityKey(a);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, a);
      continue;
    }
    const sources = [...cur.sourceObservations];
    for (const o of a.sourceObservations) {
      if (!sources.includes(o)) sources.push(o);
    }
    byKey.set(key, {
      ...cur,
      strength: Math.max(cur.strength, a.strength),
      ...(minConfidence(cur.confidence, a.confidence) !== undefined
        ? { confidence: minConfidence(cur.confidence, a.confidence) }
        : {}),
      sourceObservations: sources,
    });
  }
  return [...byKey.values()];
}

export function resolveConflicts(actions: readonly CreativeAction[]): CreativeAction[] {
  const removed = new Set<number>();

  // Subordination: vague candidate drops when the precise one exists on
  // the same pair.
  for (let i = 0; i < actions.length; i++) {
    const winner = SUBORDINATE_ACTIONS[actions[i].kind];
    if (winner === undefined) continue;
    const pair = pairKey(actions[i].target);
    if (actions.some((a, j) => j !== i && a.kind === winner && pairKey(a.target) === pair)) {
      removed.add(i);
    }
  }

  // Opposition: same target, opposite kinds — stronger wins, tie drops both.
  for (let i = 0; i < actions.length; i++) {
    if (removed.has(i)) continue;
    const a = actions[i];
    const opposite = OPPOSITE_ACTIONS[a.kind];
    if (opposite === undefined) continue;
    for (let j = i + 1; j < actions.length; j++) {
      if (removed.has(j)) continue;
      const b = actions[j];
      if (b.kind !== opposite) continue;
      if (targetKey(a.target) !== targetKey(b.target)) continue;
      // Float guard: strengths are measured floats, so "exactly at the
      // epsilon" must survive binary representation noise (0.6 − 0.55 is
      // 0.050000000000000044 in IEEE754 — still a tie).
      const diff = a.strength - b.strength;
      if (Math.abs(diff) <= OPPOSITION_TIE_EPS + 1e-9) {
        removed.add(i).add(j);
      } else {
        removed.add(diff > 0 ? j : i);
      }
      break; // one opposite per candidate — the pair is resolved
    }
  }

  return actions.filter((_, i) => !removed.has(i));
}
