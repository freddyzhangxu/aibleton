/**
 * music/reference/align.ts — current sections ↔ reference sections.
 *
 * Pure and deterministic: SectionFeatures[] + ReferenceAnalysis in,
 * alignments out. The strategy mirrors §16's priority:
 *
 *   1. explicit user target (a chosen reference section always wins)
 *   2. same role         — "Drop 2" aligns to a reference "drop"
 *   3. same ordinal      — Drop 2 prefers the reference's SECOND drop,
 *                          falling back to its first when it has only one
 *   4. similar energy / density / duration — supporting evidence
 *
 * Beat-position proximity is deliberately NOT a signal (§17): time-near ≠
 * functionally-equal. An alignment below MIN_ALIGNMENT_SCORE is not emitted —
 * "no honest match" is a first-class answer (reference_no_alignment).
 */

import type { SectionFeatures } from "../features/types.js";
import { clamp01, normRange, ONSETS_PER_BAR_FULL } from "../features/normalize.js";
import { sectionRole } from "../sections/resolve.js";
import type { ReferenceAlignment, ReferenceAlignmentReason, ReferenceAnalysis, ReferenceSection } from "./types.js";

/** Below this the pairing is a guess — the caller surfaces no-alignment. */
export const MIN_ALIGNMENT_SCORE = 0.3;

/** Component weights (documented, fixed): role identity dominates. */
const W_ROLE = 0.4;
const W_ORDINAL = 0.2;
const W_ENERGY = 0.15;
const W_DENSITY = 0.15;
const W_DURATION = 0.1;

/** A component "fires" as a reason at this component score. */
const REASON_FIRE = 0.6;

/** Current section's ordinal within its own label role ("Drop 2" → 2). */
function currentOrdinal(current: readonly SectionFeatures[], at: number): number {
  const role = sectionRole(current[at].name);
  let n = 0;
  for (let i = 0; i <= at; i++) if (sectionRole(current[i].name) === role) n++;
  return n;
}

/** Reference section's ordinal within its inferred role. */
function referenceOrdinal(sections: readonly ReferenceSection[], at: number): number {
  const role = sections[at].role;
  let n = 0;
  for (let i = 0; i <= at; i++) if (sections[i].role === role) n++;
  return n;
}

interface ScoredCandidate {
  ref: ReferenceSection;
  score: number;
  confidence?: number;
  reasons: ReferenceAlignmentReason[];
}

function scorePair(
  cur: SectionFeatures,
  curOrdinal: number,
  ref: ReferenceSection,
  refOrdinal: number,
): ScoredCandidate {
  const components: { w: number; v: number; reason: ReferenceAlignmentReason }[] = [];

  const curRole = sectionRole(cur.name);
  if (ref.role !== undefined && ref.role !== "unknown") {
    components.push({ w: W_ROLE, v: curRole === ref.role ? 1 : 0, reason: "role" });
    if (curRole === ref.role) {
      components.push({ w: W_ORDINAL, v: curOrdinal === refOrdinal ? 1 : 0, reason: "ordinal" });
    }
  }
  if (cur.energy !== undefined && ref.features.energy !== undefined) {
    components.push({
      w: W_ENERGY,
      v: clamp01(1 - Math.abs(cur.energy.value - ref.features.energy.value)),
      reason: "energy_shape",
    });
  }
  if (ref.features.density !== undefined) {
    const a = normRange(cur.density, 0, ONSETS_PER_BAR_FULL);
    const b = normRange(ref.features.density.value, 0, ONSETS_PER_BAR_FULL);
    components.push({ w: W_DENSITY, v: clamp01(1 - Math.abs(a - b)), reason: "density" });
  }
  const curLen = cur.endBeat - cur.startBeat;
  const refLen = ref.endBeat - ref.startBeat;
  if (curLen > 0 && refLen > 0) {
    components.push({
      w: W_DURATION,
      v: clamp01(1 - Math.abs(curLen - refLen) / Math.max(curLen, refLen)),
      reason: "duration",
    });
  }

  let sum = 0;
  let wPresent = 0;
  let wTotal = 0;
  for (const c of components) {
    wTotal += c.w;
    if (c.v !== undefined) {
      sum += c.v * c.w;
      wPresent += c.w;
    }
  }
  if (wTotal <= 0) return { ref, score: 0, reasons: [] };
  const score = wPresent > 0 ? sum / wPresent : 0;
  const reasons = components.filter((c) => c.v >= REASON_FIRE).map((c) => c.reason);
  if (!reasons.length && score > 0) reasons.push("similarity");

  // Weakest link: the reference section's own boundary/role confidence, and
  // the share of declared components that had evidence.
  const evidenceCoverage = wPresent / wTotal;
  const confidence = Math.min(ref.confidence, evidenceCoverage);
  return { ref, score, confidence: Math.round(confidence * 100) / 100, reasons };
}

/**
 * Align current sections to reference sections — one best alignment per
 * considered current section, best-first. `opts.currentSectionId` restricts
 * to a single target; `opts.referenceSectionId` pins the reference side
 * (explicit user target — always selected, score 1.0).
 */
export function alignReferenceSections(
  current: readonly SectionFeatures[],
  analysis: ReferenceAnalysis,
  opts?: { currentSectionId?: string; referenceSectionId?: string },
): ReferenceAlignment[] {
  const refs = analysis.sections;
  if (!current.length || !refs.length) return [];

  const explicitRef = opts?.referenceSectionId
    ? refs.find((r) => r.id === opts.referenceSectionId)
    : undefined;

  const out: ReferenceAlignment[] = [];
  for (let ci = 0; ci < current.length; ci++) {
    const cur = current[ci];
    if (opts?.currentSectionId !== undefined && cur.sectionId !== opts.currentSectionId) continue;

    if (explicitRef) {
      // Explicit user target (§16.1): the pairing is declared, not inferred —
      // the computed reasons ride along as evidence, the score is 1.
      const s = scorePair(cur, currentOrdinal(current, ci), explicitRef, referenceOrdinal(refs, refs.indexOf(explicitRef)));
      out.push({
        currentSectionId: cur.sectionId,
        referenceSectionId: explicitRef.id,
        score: 1,
        ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
        reasons: s.reasons.length ? s.reasons : ["similarity"],
      });
      continue;
    }

    let best: ScoredCandidate | undefined;
    for (let ri = 0; ri < refs.length; ri++) {
      const s = scorePair(cur, currentOrdinal(current, ci), refs[ri], referenceOrdinal(refs, ri));
      if (!best || s.score > best.score) best = s;
    }
    if (best && best.score >= MIN_ALIGNMENT_SCORE) {
      out.push({
        currentSectionId: cur.sectionId,
        referenceSectionId: best.ref.id,
        score: Math.round(best.score * 100) / 100,
        ...(best.confidence !== undefined ? { confidence: best.confidence } : {}),
        reasons: best.reasons,
      });
    }
  }

  return out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.currentSectionId < b.currentSectionId ? -1 : a.currentSectionId > b.currentSectionId ? 1 : 0) ||
      (a.referenceSectionId < b.referenceSectionId ? -1 : a.referenceSectionId > b.referenceSectionId ? 1 : 0),
  );
}
