/**
 * music/sections/resolve.ts — deterministic goal → target section.
 *
 * Resolution order is FIXED (never model-decided, never beat-guessed):
 *
 *   1. explicit id        goal.target.section matches a sectionId
 *                         ("3" or "section_3")                    conf 1.00
 *   2. exact label        case-insensitive cue-name equality      conf 1.00
 *                         (duplicate labels: first in arrangement, conf 0.60)
 *   3. normalized label   "drop_2"/"DROP-2"/"Drop #2" → "drop 2"  conf 0.95
 *   4. ordinal + role     "second drop" / "drop 2" / "last drop"  conf 0.90
 *   5. goal text          substring label match, then criteria-   conf 0.80
 *                         named sections (goal's own focus words) conf 0.75
 *   6. unmatched          { matched: false, requested } — never fabricated
 *
 * Post-execution re-matching (matchTargetSectionAfter) is a separate, looser
 * path: id → normalized label → approximate start beat (± max(4, one bar)),
 * because arrangement edits can regenerate ids and shift boundaries.
 */

import type { MusicGoal } from "../../goal/types.js";
import type { SectionFeatures } from "../features/types.js";
import type { MusicIntelligence } from "../intelligence/types.js";
import { collectGoalFocus } from "../intelligence/goal.js";
import type { SectionTarget, SectionTargetResolution } from "./types.js";

/** Fixed confidence per match kind — documented, never tuned per call. */
const CONFIDENCE: Record<SectionTarget["match"], number> = {
  id: 1.0,
  label: 1.0,
  normalized_label: 0.95,
  ordinal: 0.9,
  goal: 0.8,
  fallback: 0.6,
};

/** Ambiguous exact label (two sections both named "Drop") — deterministic
 * first-in-arrangement pick at reduced confidence (never a random pick). */
const CONFIDENCE_AMBIGUOUS_LABEL = 0.6;

// ---------------------------------------------------------------------------
// Label normalization — deliberately simple, no NLP
// ---------------------------------------------------------------------------

/** "Drop_2" / "DROP-2" / "Drop  #2" → "drop 2". */
export function normalizeSectionLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[#_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The section's role for same-role grouping: the normalized label minus a
 * trailing instance number ("Drop 2" → "drop", "Build 1" → "build").
 * Auto-generated "bars N-M" labels keep their full text — each is unique
 * positional data, not a role. This is string grouping for reference
 * ranking only; it never re-labels the user's sections. */
export function sectionRole(label: string): string {
  // Auto-generated "bars N-M" labels keep their full text — each is unique
  // positional data, not a role. (Checked on the RAW label: normalization
  // turns the dash into a space.)
  if (/^\s*bars\s+\d+\s*-\s*\d+\s*$/i.test(label)) {
    return label.trim().toLowerCase().replace(/\s+/g, " ");
  }
  return normalizeSectionLabel(label).replace(/\s+\d+$/, "");
}

// ---------------------------------------------------------------------------
// Ordinal targets — "second drop", "drop 2", "2nd chorus", "last breakdown"
// ---------------------------------------------------------------------------

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
};

export interface SectionOrdinalTarget {
  /** Role words without the ordinal ("second drop" → "drop"). */
  type: string;
  ordinal: number | "last";
}

/** Parse an ordinal section reference out of free-ish target text. The text
 * must be EXACTLY an ordinal + role (or role + number) — "make the second
 * drop stronger" is objective prose and belongs to the model, not here. */
export function parseSectionOrdinalTarget(text: string): SectionOrdinalTarget | undefined {
  const norm = normalizeSectionLabel(text);
  if (!norm) return undefined;
  let m = norm.match(/^(first|second|third|fourth|fifth|sixth|seventh|eighth) ([a-z][a-z ]*)$/);
  if (m) return { type: m[2].trim(), ordinal: ORDINAL_WORDS[m[1]] };
  m = norm.match(/^(\d+)(?:st|nd|rd|th) ([a-z][a-z ]*)$/);
  if (m) return { type: m[2].trim(), ordinal: parseInt(m[1], 10) };
  m = norm.match(/^last ([a-z][a-z ]*)$/);
  if (m) return { type: m[1].trim(), ordinal: "last" };
  // "drop 2" — trailing instance number as the ordinal.
  m = norm.match(/^([a-z][a-z ]*) (\d+)$/);
  if (m) return { type: m[1].trim(), ordinal: parseInt(m[2], 10) };
  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

function toTarget(s: SectionFeatures, match: SectionTarget["match"], requested: string, confidence?: number): SectionTarget {
  return {
    sectionId: s.sectionId,
    name: s.name,
    startBeat: s.startBeat,
    endBeat: s.endBeat,
    match,
    confidence: confidence ?? CONFIDENCE[match],
    requested,
  };
}

function matched(target: SectionTarget): SectionTargetResolution {
  return { matched: true, target };
}

/** Explicit id: "3" itself, or the "section_3" spelling. */
function matchExplicitId(sections: readonly SectionFeatures[], text: string): SectionFeatures | undefined {
  const m = text.trim().match(/^(?:section[ _]?)?(\d+)$/i);
  if (!m) return undefined;
  return sections.find((s) => s.sectionId === m[1]);
}

function resolveText(sections: readonly SectionFeatures[], raw: string): SectionTarget | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  // 1. explicit id
  const byId = matchExplicitId(sections, text);
  if (byId) return toTarget(byId, "id", text);

  // 2. exact label (case-insensitive); duplicates → first, reduced confidence
  const lower = text.toLowerCase();
  const exact = sections.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length === 1) return toTarget(exact[0], "label", text);
  if (exact.length > 1) return toTarget(exact[0], "label", text, CONFIDENCE_AMBIGUOUS_LABEL);

  // 3. normalized label
  const norm = normalizeSectionLabel(text);
  const normalized = sections.filter((s) => normalizeSectionLabel(s.name) === norm);
  if (normalized.length === 1) return toTarget(normalized[0], "normalized_label", text);
  if (normalized.length > 1) return toTarget(normalized[0], "normalized_label", text, CONFIDENCE_AMBIGUOUS_LABEL);

  // 4. ordinal + role ("second drop" / "drop 2" / "last chorus") — resolved
  // against the LABEL SEQUENCE, never beat positions.
  const ord = parseSectionOrdinalTarget(text);
  if (ord) {
    const role = normalizeSectionLabel(ord.type);
    const ofRole = sections.filter((s) => sectionRole(s.name) === role);
    if (ofRole.length) {
      const pick = ord.ordinal === "last" ? ofRole[ofRole.length - 1] : ofRole[ord.ordinal - 1];
      if (pick) return toTarget(pick, "ordinal", text);
    }
  }

  // 5. goal-text substring — the view.findSection two-step semantics the rest
  // of the goal layer already uses ("drop" finds "Drop 2").
  const sub = sections.filter((s) => normalizeSectionLabel(s.name).includes(norm));
  if (sub.length === 1) return toTarget(sub[0], "goal", text);

  return undefined;
}

// ---------------------------------------------------------------------------
// Public: resolve the goal's target section
// ---------------------------------------------------------------------------

export function resolveSectionTarget(goal: MusicGoal, intel: MusicIntelligence): SectionTargetResolution {
  const sections = intel.features.sections;
  if (!sections.length) return { matched: false, requested: goal.target?.section };

  // The declared target first, in the fixed order above.
  if (goal.target?.section) {
    const hit = resolveText(sections, goal.target.section);
    if (hit) return matched(hit);
  }

  // Then sections named by the criteria themselves ("section_energy_gt Drop
  // vs Build" names both) — the goal's own focus words, first resolver wins.
  const focus = collectGoalFocus(goal);
  for (const name of focus.sections) {
    if (name === goal.target?.section) continue; // already tried
    const hit = resolveText(sections, name.replace(/^baseline:/i, "").trim());
    if (hit) return matched({ ...hit, confidence: 0.75 });
  }

  return { matched: false, requested: goal.target?.section };
}

// ---------------------------------------------------------------------------
// Public: re-match the SAME target after execution
// ---------------------------------------------------------------------------

/** Beat tolerance for positional re-matching: one bar (from the song's own
 * duration/bars) or 4 beats, whichever is larger — deterministic, and tight
 * enough never to jump a neighbouring section in normal arrangements. */
function beatTolerance(intel: MusicIntelligence): number {
  const { durationBeats, bars } = intel.features.song;
  const barBeats = durationBeats > 0 && bars > 0 ? durationBeats / bars : 4;
  return Math.max(4, barBeats);
}

export function matchTargetSectionAfter(
  beforeTarget: SectionTarget,
  afterIntel: MusicIntelligence,
): SectionTargetResolution {
  const sections = afterIntel.features.sections;
  if (!sections.length) return { matched: false, requested: beforeTarget.name };

  // 1. same id survived
  const byId = sections.find((s) => s.sectionId === beforeTarget.sectionId);
  if (byId) {
    return matched({ ...toTarget(byId, beforeTarget.match, beforeTarget.requested ?? byId.name), confidence: beforeTarget.confidence });
  }

  // 2. normalized label survived (ids are snapshot indices — a rebuilt
  // analysis may renumber)
  const norm = normalizeSectionLabel(beforeTarget.name);
  const byLabel = sections.filter((s) => normalizeSectionLabel(s.name) === norm);
  if (byLabel.length === 1) return matched(toTarget(byLabel[0], "normalized_label", beforeTarget.requested ?? norm));
  if (byLabel.length > 1) {
    // Disambiguate duplicates by the target's previous position.
    const near = nearestByStart(byLabel, beforeTarget.startBeat);
    if (near) return matched(toTarget(near, "fallback", beforeTarget.requested ?? norm));
  }

  // 3. approximate start beat within one bar — arrangement edits shift
  // boundaries; fuzzy enough for that, never fuzzy across sections.
  const tol = beatTolerance(afterIntel);
  const near = sections.filter((s) => Math.abs(s.startBeat - beforeTarget.startBeat) <= tol);
  if (near.length === 1) return matched(toTarget(near[0], "fallback", beforeTarget.requested ?? norm));

  return { matched: false, requested: beforeTarget.name };
}

function nearestByStart(sections: readonly SectionFeatures[], startBeat: number): SectionFeatures | undefined {
  let best: SectionFeatures | undefined;
  for (const s of sections) {
    if (!best || Math.abs(s.startBeat - startBeat) < Math.abs(best.startBeat - startBeat)) best = s;
  }
  return best;
}
