import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestForGenGap } from "../../genlog/suggest.js";
import { presentReferenceVerification } from "../../music/reference/present.js";
import { presentSectionVerification } from "../../music/sections/verify.js";
import { buildPlanReport } from "../../plan/check.js";
import type { MusicPlan } from "../../plan/types.js";
import { evaluateGoal } from "../evaluate.js";
import { goalText, normalizeGoalLanguage } from "../i18n.js";
import type { MusicGoal } from "../types.js";
import type { GoalView } from "../view.js";

const CJK = /[\u3400-\u9fff]/u;

function view(roles: string[] = []): GoalView {
  return {
    tempo: 120,
    keyBest: "C major",
    liveScale: { mode: false, root: 0, name: "", intervals: [] },
    trackCount: 3,
    tracks: [],
    sections: [{ name: "bars 1-4", bars: [1, 4], notes: 16, density: 4, tracks: 3, roles: new Set(roles) }],
    songRoles: new Set(roles),
  };
}

const goal: MusicGoal = {
  type: "create",
  objective: "Create guitar and organ",
  constraints: [],
  successCriteria: [
    { kind: "role_present", role: "organ", section: "bars 1-4" },
    { kind: "role_present", role: "guitar", section: "bars 1-4" },
  ],
};

test("English role goal and plan diagnostics contain no hard-coded Chinese", () => {
  const before = view(["drums", "arp", "chords"]);
  const after = view(["drums", "arp", "chords"]);
  const evaluation = evaluateGoal(goal, before, after, "en");
  assert.equal(evaluation.met, false);
  const goalOutput = evaluation.criteriaIssues.join("\n");
  assert.match(goalOutput, /expected/i);
  assert.match(goalOutput, /Current roles/);
  assert.doesNotMatch(goalOutput, CJK);

  const plan: MusicPlan = {
    goal,
    steps: [
      {
        id: "step-1",
        description: "Make organ audible",
        tool: "write_midi_clip",
        expectedEffects: [{ metric: "role_audible", role: "organ", section: "bars 1-4" }],
      },
    ],
  };
  const report = buildPlanReport(plan, ["write_midi_clip"], before, after, "en");
  assert.equal(report.unobserved.length, 1);
  const planOutput = report.unobserved.map((effect) => `${effect.expected} ${effect.actual ?? ""}`).join("\n");
  assert.match(planOutput, /audible/i);
  assert.match(planOutput, /Current roles/);
  assert.doesNotMatch(planOutput, CJK);
});

test("section, reference, and generation retry presenters localize English", () => {
  const section = presentSectionVerification(
    {
      status: "failed",
      target: { beforeSectionId: "s1", afterSectionId: "s1" },
      matchedAfter: true,
      criteria: [{ metric: "energy", direction: "increase", required: true, weight: 1, before: 0.4, after: 0.42, delta: 0.02, status: "failed" }],
      relationshipChanges: [],
    },
    "Drop",
    "en",
  ).join("\n");
  assert.match(section, /Section check/);
  assert.doesNotMatch(section, CJK);

  const reference = presentReferenceVerification(
    [{ metric: "energy", beforeGap: 0.3, afterGap: 0.28, gapReduction: 0.02, satisfied: false }],
    "en",
  ).join("\n");
  assert.match(reference, /Reference check/);
  assert.doesNotMatch(reference, CJK);

  const hint = suggestForGenGap({ metric: "crestDb", direction: "up" }, "en");
  assert.match(hint, /punchy/);
  assert.doesNotMatch(hint, CJK);
});

test("all seven UI languages have a localized goal-check heading", () => {
  const markers: Record<string, RegExp> = {
    zh: /目标校验/,
    en: /Goal check/,
    de: /Zielprüfung/,
    fr: /Vérification de l'objectif/,
    ja: /目標検証/,
    es: /Comprobación del objetivo/,
    it: /Verifica obiettivo/,
  };
  for (const [language, marker] of Object.entries(markers)) {
    assert.match(goalText(language, "goalRetry", 1, 1, "Test goal"), marker, language);
  }
  assert.equal(normalizeGoalLanguage(undefined), "en");
  assert.equal(normalizeGoalLanguage("pt-BR"), "en");
});

test("the representative failed role criterion is localized in all seven languages", () => {
  const markers: Record<string, RegExp> = {
    zh: /现有角色/,
    en: /Current roles/,
    de: /Aktuelle Rollen/,
    fr: /Rôles présents/,
    ja: /現在の役割/,
    es: /Roles actuales/,
    it: /Ruoli attuali/,
  };
  for (const [language, marker] of Object.entries(markers)) {
    const output = evaluateGoal(goal, view(["drums"]), view(["drums"]), language).criteriaIssues.join("\n");
    assert.match(output, marker, language);
  }
});
