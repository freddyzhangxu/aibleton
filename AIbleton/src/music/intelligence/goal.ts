/**
 * music/intelligence/goal.ts — project a MusicIntelligence down to the slice
 * a declared MusicGoal needs.
 *
 * The goal is already structured (goal/ normalized it), so projection is a
 * deterministic SELECT, never a parse:
 *
 *   focus terms   ← target.{track,section} + every section/track/role named
 *                   in constraints and successCriteria
 *   resolution    ← the goal layer's own matching semantics: trim/lowercase,
 *                   exact name first, substring second (view.findSection);
 *                   roles expand through evaluate.ROLE_GROUPS (low_end →
 *                   kick|bass) — never a second role table
 *   scope growth  ← each matched section pulls only its STRONGEST "repeat"
 *                   partner (similarity ≥ 0.9): a "Drop 2" goal sees Drop
 *                   1's numbers — "similar" (≥0.7) cascades on uniform
 *                   songs, and pulling every repeat partner chains
 *                   (partner-of-partner), so the slice regrew to the song
 *   filtering     ← contrasts touching scope, similarities inside scope,
 *                   observations referencing scope, ranked by
 *                   strength × (confidence ?? 1), ties keep emission order
 *   fallback      ← nothing resolved → song scope: song + arc + the global
 *                   top observations, with the missed terms echoed (the
 *                   select.ts unmatched pattern — degraded context, never
 *                   an empty answer)
 */

import { ROLE_GROUPS } from "../../goal/evaluate.js";
import type { Criterion, MusicGoal } from "../../goal/types.js";
import type { SectionFeatures, TrackFeatures } from "../features/types.js";
import type { MusicalObservation } from "../reasoning/types.js";
import type { GoalMusicContext, MusicIntelligence } from "./types.js";

/** Observations kept in a focused projection. */
export const MAX_CONTEXT_OBSERVATIONS = 8;
/** Observations kept in the song-scope fallback. */
export const MAX_SONG_OBSERVATIONS = 5;

// ---------------------------------------------------------------------------
// Focus collection — the goal's own words, nothing invented
// ---------------------------------------------------------------------------

export interface GoalFocus {
  sections: string[];
  tracks: string[];
  roles: string[];
}

/** Strip the "baseline:" prefix — section_energy_gt's b can anchor on the
 * section's own pre-change state; the SECTION is the focus either way. */
function bareSectionName(raw: string): string {
  const m = raw.match(/^baseline:(.+)$/i);
  return (m ? m[1] : raw).trim();
}

export function collectGoalFocus(goal: MusicGoal): GoalFocus {
  const sections: string[] = [];
  const tracks: string[] = [];
  const roles: string[] = [];
  const push = (list: string[], v: string | undefined) => {
    const s = v?.trim();
    if (s && !list.includes(s)) list.push(s);
  };

  push(sections, goal.target?.section);
  push(tracks, goal.target?.track);

  const read = (c: Criterion) => {
    switch (c.kind) {
      case "section_energy_gt":
        push(sections, bareSectionName(c.a));
        push(sections, bareSectionName(c.b));
        break;
      case "section_tracks_gte":
        push(sections, c.section);
        break;
      case "role_present":
        push(roles, c.role);
        push(sections, c.section);
        break;
      case "tracks_untouched":
        for (const n of c.names) push(tracks, n);
        break;
      case "track_crest_gte":
      case "track_band_gte":
        push(tracks, c.track);
        break;
      // Global kinds (tempo_unchanged, key_unchanged, track_count_gte,
      // no_new_tracks) name nothing — they contribute no focus.
    }
  };
  goal.constraints.forEach(read);
  goal.successCriteria.forEach(read);
  return { sections, tracks, roles };
}

// ---------------------------------------------------------------------------
// Resolution — view.findSection's two-step semantics over any named row
// ---------------------------------------------------------------------------

function findByName<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
  const norm = name.trim().toLowerCase();
  if (!norm) return undefined;
  return (
    list.find((t) => t.name.toLowerCase() === norm) ??
    list.find((t) => t.name.toLowerCase().includes(norm))
  );
}

/** Roles a goal term expands to — the goal layer's group table, so a
 * role_present low_end goal and this projection can never disagree. */
function expandRole(role: string): string[] {
  return ROLE_GROUPS[role] ?? [role];
}

// ---------------------------------------------------------------------------
// Observation ranking — magnitude of effect, discounted by evidence quality;
// Array.sort is stable, so equal scores keep the reasoning layer's fixed
// emission order (determinism rides on that stability).
// ---------------------------------------------------------------------------

function rankObservations(obs: readonly MusicalObservation[], max: number): MusicalObservation[] {
  return obs
    .map((o, i) => ({ o, i, score: o.strength * (o.confidence ?? 1) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((e) => e.o);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function projectGoalContext(intel: MusicIntelligence, goal: MusicGoal): GoalMusicContext {
  const { features, relationships, reasoning } = intel;
  const focus = collectGoalFocus(goal);

  const unmatched: string[] = [];
  const sectionSet = new Map<string, SectionFeatures>();
  const trackSet = new Map<string, TrackFeatures>();

  for (const name of focus.sections) {
    const hit = findByName(features.sections, name);
    if (hit) sectionSet.set(hit.sectionId, hit);
    else unmatched.push(`section「${name}」`);
  }
  for (const name of focus.tracks) {
    const hit = findByName(features.tracks, name);
    if (hit) trackSet.set(hit.trackId, hit);
    else unmatched.push(`track「${name}」`);
  }
  for (const role of focus.roles) {
    const want = new Set(expandRole(role));
    const hits = features.tracks.filter((t) => t.role !== undefined && want.has(t.role));
    for (const t of hits) trackSet.set(t.trackId, t);
    // A role resolving to zero tracks is exactly what the planner needs to
    // know (the role must be ADDED) — echo it like any other missed focus.
    if (!hits.length) unmatched.push(`role「${role}」`);
  }

  // Scope growth: each DIRECTLY matched section pulls its single strongest
  // "repeat" partner (similarity ≥ 0.9, near-identical). Two real-machine
  // lessons shaped this: (1) "similar" pairs (≥0.7) cascade — on a uniform
  // song almost every pair clears the bar and the slice became the whole
  // song; (2) pulling EVERY repeat partner chains — the scope set grows
  // mid-iteration, so a partner's own partners join next (partner-of-
  // partner until the slice regrew). Anchoring on the direct matches and
  // keeping only each anchor's best partner is chain-proof by construction.
  const direct = new Set(sectionSet.keys());
  const best = new Map<string, { id: string; sim: number }>();
  for (const s of relationships.similarities) {
    if (s.kind !== "repeat") continue;
    const aIn = direct.has(s.aSectionId);
    const bIn = direct.has(s.bSectionId);
    if (aIn === bIn) continue; // both anchored or neither — nothing to pull
    const anchor = aIn ? s.aSectionId : s.bSectionId;
    const partner = aIn ? s.bSectionId : s.aSectionId;
    const cur = best.get(anchor);
    if (!cur || s.similarity.value > cur.sim) {
      best.set(anchor, { id: partner, sim: s.similarity.value });
    }
  }
  for (const { id } of best.values()) {
    const partner = features.sections.find((f) => f.sectionId === id);
    if (partner) sectionSet.set(partner.sectionId, partner);
  }

  const focused = sectionSet.size > 0 || trackSet.size > 0;
  const sections = features.sections.filter((s) => sectionSet.has(s.sectionId));
  const tracks = features.tracks.filter((t) => trackSet.has(t.trackId));

  const contrasts = focused
    ? relationships.contrasts.filter(
        (c) => sectionSet.has(c.fromSectionId) || sectionSet.has(c.toSectionId),
      )
    : [];
  const similarities = focused
    ? relationships.similarities.filter(
        (s) => sectionSet.has(s.aSectionId) && sectionSet.has(s.bSectionId),
      )
    : [];

  const observations = focused
    ? rankObservations(
        reasoning.observations.filter(
          (o) =>
            (o.sectionId !== undefined && sectionSet.has(o.sectionId)) ||
            (o.relatedSectionId !== undefined && sectionSet.has(o.relatedSectionId)) ||
            (o.trackId !== undefined && trackSet.has(o.trackId)) ||
            (o.relatedTrackId !== undefined && trackSet.has(o.relatedTrackId)),
        ),
        MAX_CONTEXT_OBSERVATIONS,
      )
    : rankObservations(reasoning.observations, MAX_SONG_OBSERVATIONS);

  return {
    scope: focused ? "focused" : "song",
    target: { ...(goal.target?.track ? { track: goal.target.track } : {}),
              ...(goal.target?.section ? { section: goal.target.section } : {}) },
    sections,
    tracks,
    contrasts,
    similarities,
    arc: relationships.arc,
    song: features.song,
    observations,
    coverage: reasoning.coverage,
    unmatched,
  };
}
