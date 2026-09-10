/**
 * music/sections/reference.ts — choose the target's COMPARISON anchors.
 *
 * References answer "what should the planner compare the target against to
 * judge it?" — never "what else should be edited". Current Live Set sections
 * ONLY (external reference tracks are PR16).
 *
 * Deterministic relevance anchors (documented, fixed):
 *
 *   criteria partner   a section the goal's criteria explicitly compares    1.00
 *                      the target against ("section_energy_gt Drop Build") —
 *                      the goal's own declared comparison outranks every
 *                      organic signal
 *   reprise partner    relationships kind "repeat" — 0.75 + 0.25·similarity
 *   same-role          "Drop 1" for target "Drop 2" — 0.70 (+ similarity
 *                      echo when the pair has one; unknown similarity never
 *                      becomes 0)
 *   contrast partner   strongest energyDelta touching the target —
 *                      0.55 + 0.25·min(1, |Δ|·2), 0.55 when unknown
 *                      (capped below reprise: a big Drop→Outro fall must not
 *                      outrank the Drop 1 a Drop 2 goal actually compares
 *                      against)
 *   previous section   the build-up is how a drop's strength is judged      0.60
 *   next section                                                            0.50
 *   arrangement peak                                                          0.55
 *
 * A section that qualifies for several reasons keeps the highest-priority one
 * (criteria > reprise > same_role > contrast > previous > next > peak).
 * Selection: relevance desc, ties by beat position then sectionId — and the
 * target itself is never its own reference.
 */

import type { MusicGoal } from "../../goal/types.js";
import type { MusicIntelligence } from "../intelligence/types.js";
import { collectGoalFocus } from "../intelligence/goal.js";
import { normalizeSectionLabel, sectionRole } from "./resolve.js";
import type { SectionReference, SectionReferenceReason, SectionTarget } from "./types.js";

/** Reason priority when a section qualifies for more than one. */
const REASON_PRIORITY: SectionReferenceReason[] = [
  "contrast", // criteria partner — see Candidate.contrastCriteria flag below
  "reprise",
  "same_role",
  "similar",
  "previous",
  "next",
  "peak",
];

export const MAX_SECTION_REFERENCES = 3;

interface Candidate {
  sectionId: string;
  name: string;
  startBeat: number;
  reason: SectionReferenceReason;
  relevance: number;
  /** Criteria partners outrank organic contrast partners at the same reason. */
  fromCriteria: boolean;
  similarity?: number;
  contrast?: number;
}

export function selectSectionReferences(
  target: SectionTarget,
  intel: MusicIntelligence,
  goal?: MusicGoal,
  maxReferences: number = MAX_SECTION_REFERENCES,
): SectionReference[] {
  const { sections } = intel.features;
  const { contrasts, similarities, arc } = intel.relationships;
  const byId = new Map(sections.map((s) => [s.sectionId, s]));
  const targetIdx = sections.findIndex((s) => s.sectionId === target.sectionId);
  if (targetIdx < 0) return [];

  const candidates = new Map<string, Candidate>();
  const offer = (c: Candidate) => {
    if (c.sectionId === target.sectionId) return; // never self-reference
    const cur = candidates.get(c.sectionId);
    if (!cur) {
      candidates.set(c.sectionId, c);
      return;
    }
    // Higher-priority reason wins; same reason keeps the stronger relevance;
    // a criteria anchor always beats an organic one at the same reason.
    const pri = (r: SectionReferenceReason) => REASON_PRIORITY.indexOf(r);
    const better =
      pri(c.reason) < pri(cur.reason) ||
      (c.reason === cur.reason &&
        (c.relevance > cur.relevance || (c.fromCriteria && !cur.fromCriteria)));
    if (better) candidates.set(c.sectionId, c);
  };

  // --- Criteria partners: sections the goal explicitly compares against ---
  if (goal) {
    const focus = collectGoalFocus(goal);
    for (const raw of focus.sections) {
      const name = raw.replace(/^baseline:/i, "").trim();
      const norm = normalizeSectionLabel(name);
      const hit =
        sections.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
        sections.find((s) => normalizeSectionLabel(s.name) === norm);
      if (hit && hit.sectionId !== target.sectionId) {
        offer({
          sectionId: hit.sectionId,
          name: hit.name,
          startBeat: hit.startBeat,
          reason: "contrast",
          relevance: 1.0,
          fromCriteria: true,
        });
      }
    }
  }

  // --- Reprise / similar partners from the relationships layer ---
  for (const s of similarities) {
    const partnerId =
      s.aSectionId === target.sectionId ? s.bSectionId :
      s.bSectionId === target.sectionId ? s.aSectionId : undefined;
    if (!partnerId) continue;
    const partner = byId.get(partnerId);
    if (!partner) continue;
    if (s.kind === "repeat") {
      offer({
        sectionId: partnerId,
        name: partner.name,
        startBeat: partner.startBeat,
        reason: "reprise",
        relevance: 0.75 + 0.25 * s.similarity.value,
        fromCriteria: false,
        similarity: s.similarity.value,
      });
    } else if (s.kind === "similar") {
      offer({
        sectionId: partnerId,
        name: partner.name,
        startBeat: partner.startBeat,
        reason: "similar",
        relevance: 0.65 + 0.2 * s.similarity.value,
        fromCriteria: false,
        similarity: s.similarity.value,
      });
    }
  }

  // --- Same-role sections (label grouping only — never re-labels) ---
  const role = sectionRole(target.name);
  for (const s of sections) {
    if (s.sectionId === target.sectionId) continue;
    if (sectionRole(s.name) !== role) continue;
    offer({
      sectionId: s.sectionId,
      name: s.name,
      startBeat: s.startBeat,
      reason: "same_role",
      relevance: 0.7,
      fromCriteria: false,
    });
  }

  // --- Strongest contrast partner touching the target ---
  let bestContrast: { partnerId: string; delta?: number } | undefined;
  for (const c of contrasts) {
    const partnerId =
      c.fromSectionId === target.sectionId ? c.toSectionId :
      c.toSectionId === target.sectionId ? c.fromSectionId : undefined;
    if (!partnerId) continue;
    const mag = c.energyDelta ? Math.abs(c.energyDelta.value) : undefined;
    if (!bestContrast || (mag !== undefined && (bestContrast.delta === undefined || mag > bestContrast.delta))) {
      bestContrast = { partnerId, delta: mag };
    }
  }
  if (bestContrast) {
    const partner = byId.get(bestContrast.partnerId);
    if (partner) {
      offer({
        sectionId: partner.sectionId,
        name: partner.name,
        startBeat: partner.startBeat,
        reason: "contrast",
        relevance: 0.55 + 0.25 * Math.min(1, (bestContrast.delta ?? 0) * 2),
        fromCriteria: false,
        ...(bestContrast.delta !== undefined ? { contrast: bestContrast.delta } : {}),
      });
    }
  }

  // --- Arrangement neighbours ---
  const prev = sections[targetIdx - 1];
  if (prev) {
    offer({ sectionId: prev.sectionId, name: prev.name, startBeat: prev.startBeat, reason: "previous", relevance: 0.6, fromCriteria: false });
  }
  const next = sections[targetIdx + 1];
  if (next) {
    offer({ sectionId: next.sectionId, name: next.name, startBeat: next.startBeat, reason: "next", relevance: 0.5, fromCriteria: false });
  }

  // --- Arrangement peak ---
  if (arc.peakSectionId !== undefined && arc.peakSectionId !== target.sectionId) {
    const peak = byId.get(arc.peakSectionId);
    if (peak) {
      offer({ sectionId: peak.sectionId, name: peak.name, startBeat: peak.startBeat, reason: "peak", relevance: 0.55, fromCriteria: false });
    }
  }

  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        a.startBeat - b.startBeat ||
        (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0),
    )
    .slice(0, Math.max(0, maxReferences))
    .map((c) => ({
      sectionId: c.sectionId,
      name: c.name,
      reason: c.reason,
      relevance: Math.round(c.relevance * 100) / 100,
      ...(c.similarity !== undefined ? { similarity: c.similarity } : {}),
      ...(c.contrast !== undefined ? { contrast: c.contrast } : {}),
    }));
}
