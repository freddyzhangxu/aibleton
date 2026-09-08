/**
 * analysis/select.ts — Context Selector: resolve an analyze_song `focus`
 * string to the slices of the Set it refers to, so present.ts can render a
 * focused projection instead of the full SongAnalysis.
 *
 * Fully deterministic — no LLM pre-pass, same philosophy as verify/ and
 * goalGate. Signals (unioned, in this order):
 *
 *   1. track NAME   — focus is a substring of a track name (or vice versa)
 *   2. track ROLE   — focus matches the ROLE_KEYWORDS vocabulary (interpret.ts);
 *                     the generic words "drums"/"percussion" select ALL drum
 *                     tracks, a specific piece ("kick") only that role
 *   3. issue CODE   — focus names an issue ("MONOTONE_BASS", "monotone bass")
 *   4. section NAME — echo only; never selects tracks on its own
 *
 * Issues pointing at already-selected tracks become relevant, and every
 * relevant issue's tracks join the selection (a DUPLICATE_CONTENT pair stays
 * comparable; a MONOTONE_BASS track named "LowEnd" — no role keyword — is
 * still found). Nothing matched → unmatched: present.ts falls back to the
 * full analysis and echoes why.
 */

import type { MusicState } from "../musicstate/types.js";
import { ROLE_KEYWORDS } from "./interpret.js";
import type { MusicIssue, MusicAnalysis, TrackRole } from "./types.js";

/** The selector's output: which slices of the Set the focus refers to.
 * Internal structure — never goes on the wire (present.ts renders from it). */
export interface ContextSelection {
  focusRaw: string;
  trackIndices: Set<number>; // tracks that get full stats rows
  relevantIssues: MusicIssue[]; // issues touching selected tracks / named in the focus
  sectionFocus: Map<string, number[]>; // section name -> active selected track indices
  matched: string[]; // echo tags: "track:Bass" | "role:bass" | "issue:MONOTONE_BASS" | "section:Drop"
  unmatched: boolean; // nothing matched — present.ts falls back to the full analysis
}

/** Drum-group roles: the generic focus words select every isDrums track. */
const GENERIC_DRUM_ROLES: ReadonlySet<TrackRole> = new Set(["drums", "percussion"]);

/** Normalize for issue-code matching: "monotone bass" -> "MONOTONE_BASS". */
function normCode(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, "_");
}

/** Indices of the selected tracks audible in one section — the same onset
 * walk goal/view.ts uses (loop region tiled across the clip, bar-aligned
 * section ranges). bars are 1-based inclusive. */
export function focusTracksPerSection(
  state: MusicState,
  bars: [number, number],
  trackIndices: ReadonlySet<number>,
): number[] {
  if (trackIndices.size === 0) return [];
  const startBeat = (bars[0] - 1) * state.barBeats;
  const endBeat = bars[1] * state.barBeats;
  const active: number[] = [];
  for (const ts of state.tracks) {
    if (!trackIndices.has(ts.track.index) || ts.muted) continue;
    let found = false;
    for (const cs of ts.clips) {
      const { clip, window: win, material } = cs;
      if (clip.start === null || clip.muted || material.length === 0) continue;
      const tiles = Math.max(1, Math.ceil(clip.duration / Math.max(win.loopLen, 1e-6) - 1e-6));
      outer: for (let k = 0; k < tiles; k++) {
        for (const n of material) {
          const onset = clip.start + (n.start - win.winStart) + k * win.loopLen;
          if (onset >= startBeat - 1e-6 && onset < endBeat - 1e-6) {
            found = true;
            break outer;
          }
        }
      }
      if (found) break;
    }
    if (found) active.push(ts.track.index);
  }
  return active;
}

/** Resolve a focus string against the Set. Pure; no Live SDK. */
export function selectMusicContext(
  state: MusicState,
  ma: MusicAnalysis,
  focus: string,
): ContextSelection {
  const raw = focus.trim();
  const lower = raw.toLowerCase();
  const trackIndices = new Set<number>();
  const matched: string[] = [];

  // 1. Track name — bidirectional substring ("bass guitar" finds "Bass").
  if (lower.length >= 2) {
    for (const ts of state.tracks) {
      const name = ts.track.name.toLowerCase();
      if (name.includes(lower) || lower.includes(name)) {
        trackIndices.add(ts.track.index);
        const tag = `track:${ts.track.name}`;
        if (!matched.includes(tag)) matched.push(tag);
      }
    }
  }

  // 2. Role vocabulary — first-match-wins per role entry; generic drum words
  //    widen to every isDrums track.
  const hitRoles = new Set<TrackRole>();
  for (const [role, re] of ROLE_KEYWORDS) {
    if (re.test(raw)) hitRoles.add(role);
  }
  if (hitRoles.size > 0) {
    const widenDrums = [...hitRoles].some((r) => GENERIC_DRUM_ROLES.has(r));
    ma.trackRoles.forEach((tra, i) => {
      const hit = widenDrums && tra.isDrums ? true : hitRoles.has(tra.role);
      if (hit && state.tracks[i]) {
        trackIndices.add(tra.i);
        const tag = `role:${tra.role}`;
        if (!matched.includes(tag)) matched.push(tag);
      }
    });
  }

  // 3. Issue codes named in the focus — only issues actually present can match.
  const code = normCode(raw);
  const namedIssues = ma.issues.filter((i) => code.includes(i.code));
  for (const i of namedIssues) {
    const tag = `issue:${i.code}`;
    if (!matched.includes(tag)) matched.push(tag);
    for (const t of i.tracks ?? []) trackIndices.add(t);
  }

  // 4. Section names — echo only, never selects tracks.
  for (const s of ma.sections) {
    const sn = s.name.toLowerCase();
    if ((sn.includes(lower) || lower.includes(sn)) && !matched.includes(`section:${s.name}`)) {
      matched.push(`section:${s.name}`);
    }
  }

  // Issues touching any selected track are relevant; their tracks join the
  // selection (one pass — no transitive closure).
  const relevantIssues: MusicIssue[] = [];
  for (const i of ma.issues) {
    if (namedIssues.includes(i) || (i.tracks ?? []).some((t) => trackIndices.has(t))) {
      relevantIssues.push(i);
      for (const t of i.tracks ?? []) trackIndices.add(t);
    }
  }

  const unmatched = trackIndices.size === 0 && matched.length === 0;

  // Selected-track activity per section (present.ts renders it as
  // sections[].focusTracks).
  const sectionFocus = new Map<string, number[]>();
  if (!unmatched && trackIndices.size > 0) {
    for (const s of ma.sections) {
      sectionFocus.set(s.name, focusTracksPerSection(state, s.bars, trackIndices));
    }
  }

  return { focusRaw: raw, trackIndices, relevantIssues, sectionFocus, matched, unmatched };
}
