/**
 * resolve.test.ts — deterministic goal → target section: the fixed
 * id/label/normalized/ordinal/goal order, no-match honesty, duplicate-label
 * determinism, and post-execution re-matching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  matchTargetSectionAfter,
  normalizeSectionLabel,
  parseSectionOrdinalTarget,
  resolveSectionTarget,
  sectionRole,
} from "../resolve.js";
import { goalOf, sevenSectionIntel } from "./fixtures.js";

test("normalize: case/underscore/dash/hash collapse to one form", () => {
  assert.equal(normalizeSectionLabel("Drop 2"), "drop 2");
  assert.equal(normalizeSectionLabel("drop_2"), "drop 2");
  assert.equal(normalizeSectionLabel("DROP-2"), "drop 2");
  assert.equal(normalizeSectionLabel("Drop  #2"), "drop 2");
});

test("role: trailing instance numbers group; bars labels stay unique", () => {
  assert.equal(sectionRole("Drop 2"), "drop");
  assert.equal(sectionRole("build_1"), "build");
  assert.equal(sectionRole("Chorus"), "chorus");
  assert.equal(sectionRole("bars 9-16"), "bars 9-16");
});

test("ordinal parser: words, digits, suffixes, last", () => {
  assert.deepEqual(parseSectionOrdinalTarget("second drop"), { type: "drop", ordinal: 2 });
  assert.deepEqual(parseSectionOrdinalTarget("drop 2"), { type: "drop", ordinal: 2 });
  assert.deepEqual(parseSectionOrdinalTarget("2nd chorus"), { type: "chorus", ordinal: 2 });
  assert.deepEqual(parseSectionOrdinalTarget("last breakdown"), { type: "breakdown", ordinal: "last" });
  assert.equal(parseSectionOrdinalTarget("make the drop stronger"), undefined);
  assert.equal(parseSectionOrdinalTarget(""), undefined);
});

test("resolve: explicit id, both spellings", () => {
  const intel = sevenSectionIntel();
  const byBare = resolveSectionTarget(goalOf({ target: { section: "5" } }), intel);
  assert.deepEqual(byBare, {
    matched: true,
    target: {
      sectionId: "5",
      name: "Drop 2",
      startBeat: 160,
      endBeat: 192,
      match: "id",
      confidence: 1,
      requested: "5",
    },
  });
  const byPrefix = resolveSectionTarget(goalOf({ target: { section: "section_5" } }), intel);
  assert.equal(byPrefix.matched, true);
  if (byPrefix.matched) assert.equal(byPrefix.target.sectionId, "5");
});

test("resolve: exact label, case-insensitive", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "drop 2" } }), intel);
  assert.equal(r.matched, true);
  if (r.matched) {
    assert.equal(r.target.sectionId, "5");
    assert.equal(r.target.match, "label");
    assert.equal(r.target.confidence, 1);
  }
});

test("resolve: normalized label", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "drop_2" } }), intel);
  assert.equal(r.matched, true);
  if (r.matched) {
    assert.equal(r.target.sectionId, "5");
    assert.equal(r.target.match, "normalized_label");
    assert.equal(r.target.confidence, 0.95);
  }
});

test("resolve: ordinal and last", () => {
  const intel = sevenSectionIntel();
  const second = resolveSectionTarget(goalOf({ target: { section: "second drop" } }), intel);
  assert.equal(second.matched, true);
  if (second.matched) {
    assert.equal(second.target.sectionId, "5");
    assert.equal(second.target.match, "ordinal");
    assert.equal(second.target.confidence, 0.9);
  }
  const last = resolveSectionTarget(goalOf({ target: { section: "last drop" } }), intel);
  assert.equal(last.matched, true);
  if (last.matched) assert.equal(last.target.sectionId, "5");
  const firstBuild = resolveSectionTarget(goalOf({ target: { section: "first build" } }), intel);
  assert.equal(firstBuild.matched, true);
  if (firstBuild.matched) assert.equal(firstBuild.target.sectionId, "1");
});

test("resolve: criteria-named sections resolve when target is absent", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(
    goalOf({ successCriteria: [{ kind: "section_energy_gt", a: "Drop 1", b: "baseline:Drop 1" }] }),
    intel,
  );
  assert.equal(r.matched, true);
  if (r.matched) {
    assert.equal(r.target.sectionId, "2");
    assert.equal(r.target.confidence, 0.75);
  }
});

test("resolve: unknown section is unmatched, never fabricated", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "chorus" } }), intel);
  assert.deepEqual(r, { matched: false, requested: "chorus" });
});

test("resolve: empty arrangement is unmatched", () => {
  const intel = sevenSectionIntel();
  intel.features.sections = [];
  const r = resolveSectionTarget(goalOf({ target: { section: "Drop" } }), intel);
  assert.equal(r.matched, false);
});

test("resolve: duplicate labels pick first deterministically at lower confidence", () => {
  const intel = sevenSectionIntel();
  intel.features.sections[5] = { ...intel.features.sections[5], name: "Drop 1" }; // two "Drop 1"s
  const r = resolveSectionTarget(goalOf({ target: { section: "drop 1" } }), intel);
  assert.equal(r.matched, true);
  if (r.matched) {
    assert.equal(r.target.sectionId, "2"); // arrangement order, not random
    assert.equal(r.target.confidence, 0.6);
  }
});

test("resolve: deterministic across 100 runs", () => {
  const intel = sevenSectionIntel();
  const goal = goalOf({ target: { section: "second drop" } });
  const first = resolveSectionTarget(goal, intel);
  for (let i = 0; i < 100; i++) assert.deepEqual(resolveSectionTarget(goal, intel), first);
});

test("rematch: same id survives", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "Drop 2" } }), intel);
  assert.equal(r.matched, true);
  if (!r.matched) return;
  const after = matchTargetSectionAfter(r.target, intel);
  assert.equal(after.matched, true);
  if (after.matched) assert.equal(after.target.sectionId, "5");
});

test("rematch: renumbered ids fall back to normalized label", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "Drop 2" } }), intel);
  assert.equal(r.matched, true);
  if (!r.matched) return;
  const after = sevenSectionIntel();
  after.features.sections = after.features.sections.map((s, i) => ({ ...s, sectionId: String(i + 10) }));
  const m = matchTargetSectionAfter(r.target, after);
  assert.equal(m.matched, true);
  if (m.matched) assert.equal(m.target.name, "Drop 2");
});

test("rematch: shifted boundary within one bar falls back to position", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "Drop 2" } }), intel);
  assert.equal(r.matched, true);
  if (!r.matched) return;
  const after = sevenSectionIntel();
  // New ids AND renamed section (a rebuilt analysis), start moved by 2 beats.
  after.features.sections = after.features.sections.map((s, i) => ({
    ...s,
    sectionId: String(i + 20),
    name: `Section ${i + 1}`,
    startBeat: s.startBeat + 2,
    endBeat: s.endBeat + 2,
  }));
  const m = matchTargetSectionAfter(r.target, after);
  assert.equal(m.matched, true);
  if (m.matched) {
    assert.equal(m.target.startBeat, 162);
    assert.equal(m.target.match, "fallback");
  }
});

test("rematch: deleted target is unmatched — unknown, not fabricated", () => {
  const intel = sevenSectionIntel();
  const r = resolveSectionTarget(goalOf({ target: { section: "Drop 2" } }), intel);
  assert.equal(r.matched, true);
  if (!r.matched) return;
  const after = sevenSectionIntel();
  after.features.sections = after.features.sections.filter((s) => s.sectionId !== "5");
  const m = matchTargetSectionAfter(r.target, after);
  assert.equal(m.matched, false);
});
