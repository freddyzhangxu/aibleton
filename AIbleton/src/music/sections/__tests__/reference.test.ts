/**
 * reference.test.ts — internal reference selection: same-role/reprise
 * partners for a second-instance target, contrast anchors for contrast
 * goals, the cap, self-exclusion, and stable ordering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSectionTarget } from "../resolve.js";
import { selectSectionReferences } from "../reference.js";
import { goalOf, sevenSectionIntel } from "./fixtures.js";

function targetOf(intel: ReturnType<typeof sevenSectionIntel>, section: string) {
  const r = resolveSectionTarget(goalOf({ target: { section } }), intel);
  assert.equal(r.matched, true, `target ${section} should resolve`);
  return r.matched ? r.target : assert.fail();
}

test("Drop 2 target includes Drop 1 as reprise/same-role reference", () => {
  const intel = sevenSectionIntel();
  const refs = selectSectionReferences(targetOf(intel, "Drop 2"), intel);
  const drop1 = refs.find((r) => r.name === "Drop 1");
  assert.ok(drop1, "Drop 1 must be a reference");
  assert.equal(drop1.reason, "reprise"); // repeat pair beats plain same_role
  assert.equal(drop1.similarity, 0.91); // echoed, never dropped
});

test("contrast goal: criteria partner is the top reference", () => {
  const intel = sevenSectionIntel();
  const goal = goalOf({
    target: { section: "Drop 2" },
    successCriteria: [{ kind: "section_energy_gt", a: "Drop 2", b: "Build 2" }],
  });
  const refs = selectSectionReferences(targetOf(intel, "Drop 2"), intel, goal);
  assert.equal(refs[0].name, "Build 2");
  assert.equal(refs[0].reason, "contrast");
  assert.ok(refs[0].relevance > 0.9);
});

test("single-instance target gets previous/next neighbours", () => {
  const intel = sevenSectionIntel();
  const refs = selectSectionReferences(targetOf(intel, "Breakdown"), intel);
  const names = refs.map((r) => r.name);
  assert.ok(names.includes("Drop 1") || names.includes("Build 2"), `neighbours expected, got ${names}`);
});

test("target is never its own reference", () => {
  const intel = sevenSectionIntel();
  const refs = selectSectionReferences(targetOf(intel, "Drop 2"), intel);
  assert.ok(refs.every((r) => r.sectionId !== "5"));
});

test("cap: maxReferences is honored", () => {
  const intel = sevenSectionIntel();
  const t = targetOf(intel, "Drop 2");
  assert.ok(selectSectionReferences(t, intel, undefined, 3).length <= 3);
  assert.ok(selectSectionReferences(t, intel, undefined, 1).length <= 1);
  assert.equal(selectSectionReferences(t, intel, undefined, 0).length, 0);
});

test("ordering: relevance desc, then beat position, then id — deterministic", () => {
  const intel = sevenSectionIntel();
  const t = targetOf(intel, "Drop 2");
  const first = selectSectionReferences(t, intel);
  for (let i = 0; i < 50; i++) assert.deepEqual(selectSectionReferences(t, intel), first);
  for (let i = 1; i < first.length; i++) assert.ok(first[i - 1].relevance >= first[i].relevance);
});

test("unknown similarity never becomes 0", () => {
  const intel = sevenSectionIntel({ similarities: [] }); // relationships silent
  const refs = selectSectionReferences(targetOf(intel, "Drop 2"), intel);
  const drop1 = refs.find((r) => r.name === "Drop 1");
  assert.ok(drop1, "same-role grouping alone still surfaces Drop 1");
  assert.equal(drop1.reason, "same_role");
  assert.equal(drop1.similarity, undefined); // absent — not 0
});

test("single-section song yields no references", () => {
  const intel = sevenSectionIntel();
  intel.features.sections = intel.features.sections.filter((s) => s.sectionId === "5");
  const refs = selectSectionReferences(targetOf(intel, "Drop 2"), intel);
  assert.deepEqual(refs, []);
});
