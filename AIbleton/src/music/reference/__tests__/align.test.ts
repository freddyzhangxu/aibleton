/**
 * align.test.ts — role/ordinal preference, similarity evidence, explicit
 * pinning, no-honest-match, deterministic ordering. Never beat-position
 * proximity (§17).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { alignReferenceSections, MIN_ALIGNMENT_SCORE } from "../align.js";
import { curSection, fv, refAnalysis, refSection } from "./fixtures.js";
import type { SectionFeatures } from "../../features/types.js";

/** The canonical current arrangement: Intro / Build / Drop 1 / Drop 2. */
function currentSections(): SectionFeatures[] {
  let beat = 0;
  const mk = (id: string, name: string, energy: number, density: number): SectionFeatures => {
    const s = curSection(id, name, {
      startBeat: beat,
      endBeat: beat + 32,
      energy: fv(energy),
      density,
    });
    beat += 32;
    return s;
  };
  return [
    mk("0", "Intro", 0.2, 0.5),
    mk("1", "Build", 0.5, 2),
    mk("2", "Drop 1", 0.8, 4),
    mk("3", "Drop 2", 0.78, 4),
  ];
}

test("Fixture D: same role + same ordinal wins (Drop 2 ↔ reference Drop 2)", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "intro", startBeat: 0, endBeat: 32, features: { energy: fv(0.25), density: fv(0.6) } }),
    refSection(1, { role: "drop", label: "Drop 1", startBeat: 32, endBeat: 64, features: { energy: fv(0.85), density: fv(4.2) } }),
    refSection(2, { role: "drop", label: "Drop 2", startBeat: 64, endBeat: 96, features: { energy: fv(0.8), density: fv(4) } }),
  ]);
  const alignments = alignReferenceSections(currentSections(), analysis, { currentSectionId: "3" });
  assert.equal(alignments.length, 1);
  assert.equal(alignments[0].referenceSectionId, "reference:section:2");
  assert.ok(alignments[0].reasons.includes("role"));
  assert.ok(alignments[0].reasons.includes("ordinal"));
});

test("Fixture E: without a second drop, Drop 2 falls back to the reference's first", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "intro", startBeat: 0, endBeat: 32, features: { energy: fv(0.25) } }),
    refSection(1, { role: "drop", label: "Drop 1", startBeat: 32, endBeat: 64, features: { energy: fv(0.85), density: fv(4.2) } }),
  ]);
  const alignments = alignReferenceSections(currentSections(), analysis, { currentSectionId: "3" });
  assert.equal(alignments.length, 1);
  assert.equal(alignments[0].referenceSectionId, "reference:section:1");
  assert.ok(alignments[0].reasons.includes("role"));
  assert.ok(!alignments[0].reasons.includes("ordinal"));
});

test("explicit user pin always selects the pinned reference section (score 1)", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "intro", features: { energy: fv(0.2) } }),
    refSection(1, { role: "drop", features: { energy: fv(0.9) } }),
  ]);
  const alignments = alignReferenceSections(currentSections(), analysis, {
    currentSectionId: "3",
    referenceSectionId: "reference:section:0",
  });
  assert.equal(alignments.length, 1);
  assert.equal(alignments[0].referenceSectionId, "reference:section:0");
  assert.equal(alignments[0].score, 1);
});

test("no honest match → no alignment (never a nearest-in-time guess)", () => {
  // Everything maximally different, role unknown, durations far apart.
  const analysis = refAnalysis([
    refSection(0, { role: "unknown", startBeat: 0, endBeat: 400, features: { energy: fv(0.05), density: fv(16) } }),
  ]);
  const cur = [curSection("0", "Drop 2", { startBeat: 0, endBeat: 8, energy: fv(0.95), density: 0.2 })];
  const alignments = alignReferenceSections(cur, analysis);
  assert.equal(alignments.length, 0);
});

test("role dominates over energy similarity", () => {
  // The energy-twin is an intro; the role match is a drop. Role must win.
  const analysis = refAnalysis([
    refSection(0, { role: "intro", startBeat: 0, endBeat: 32, features: { energy: fv(0.79), density: fv(4) } }),
    refSection(1, { role: "drop", startBeat: 32, endBeat: 64, features: { energy: fv(0.5), density: fv(1) } }),
  ]);
  const alignments = alignReferenceSections(currentSections(), analysis, { currentSectionId: "3" });
  assert.equal(alignments[0].referenceSectionId, "reference:section:1");
});

test("all current sections align best-first when no target is given", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "intro", startBeat: 0, endBeat: 32, features: { energy: fv(0.2), density: fv(0.5) } }),
    refSection(1, { role: "drop", startBeat: 32, endBeat: 64, features: { energy: fv(0.85), density: fv(4) } }),
  ]);
  const alignments = alignReferenceSections(currentSections(), analysis);
  assert.ok(alignments.length >= 3);
  // Sorted by score desc, ties deterministic.
  for (let i = 1; i < alignments.length; i++) {
    assert.ok(alignments[i - 1].score >= alignments[i].score);
  }
  // Every alignment clears the honesty floor.
  assert.ok(alignments.every((a) => a.score >= MIN_ALIGNMENT_SCORE));
});

test("unknown features never become fake similarity (energy absent on one side)", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "drop", startBeat: 0, endBeat: 32, features: { density: fv(4) } }),
  ]);
  const cur = [curSection("0", "Drop 1", { density: 4 })]; // no energy on either side
  const alignments = alignReferenceSections(cur, analysis);
  assert.equal(alignments.length, 1);
  // Role + density + duration components only — no energy evidence either way.
  assert.ok(!alignments[0].reasons.includes("energy_shape"));
});

test("deterministic: identical inputs → identical alignments", () => {
  const analysis = refAnalysis([
    refSection(0, { role: "intro", features: { energy: fv(0.2) } }),
    refSection(1, { role: "drop", features: { energy: fv(0.85) } }),
  ]);
  assert.deepEqual(
    alignReferenceSections(currentSections(), analysis),
    alignReferenceSections(currentSections(), analysis),
  );
});
