import assert from "node:assert/strict";
import test from "node:test";

import { instrumentPromptFor } from "./instruments.js";
import { selectWorkflowRules } from "./workflows.js";

const analysisRequests = [
  ["en", "Analyze the bass and mix."],
  ["zh", "分析低频和混音"],
  ["de", "Analysiere den Bass und den Mix."],
  ["fr", "Analyse la basse et le mix."],
  ["ja", "ベースとミックスを分析して"],
  ["es", "Analiza el bajo y la mezcla."],
  ["it", "Analizza il basso e il mix."],
] as const;

const creationRequests = [
  ["en", "Write a bassline."],
  ["zh", "写一条贝斯线"],
  ["de", "Schreibe eine Basslinie."],
  ["fr", "Écris une ligne de basse."],
  ["ja", "ベースラインを作って"],
  ["es", "Crea una línea de bajo."],
  ["it", "Crea una linea di basso."],
] as const;

test("recognizes read-only analysis requests in every supported UI language", () => {
  for (const [language, request] of analysisRequests) {
    const { prompt, sectionChars } = selectWorkflowRules(request);
    assert.match(prompt, /Song analysis \(read-only\):/, `${language} analysis workflow`);
    assert.ok(sectionChars["Song analysis (read-only)"] > 0, `${language} section diagnostics`);
    assert.doesNotMatch(prompt, /Goals \(tasks that change the Set\):/, `${language} stays read-only`);
    assert.doesNotMatch(prompt, /Making music that actually produces sound:/, `${language} omits creation rules`);
  }
});

test("recognizes creation requests in every supported UI language and keeps goal/plan guidance", () => {
  for (const [language, request] of creationRequests) {
    const { prompt, sectionChars } = selectWorkflowRules(request);
    assert.match(prompt, /Making music that actually produces sound:/, `${language} creation workflow`);
    assert.match(prompt, /Goals \(tasks that change the Set\):/, `${language} goal guidance`);
    assert.match(prompt, /Plans \(multi-step tasks\):/, `${language} plan guidance`);
    assert.ok(sectionChars["Making music that actually produces sound"] > 0, `${language} section diagnostics`);
  }
});

test("selects the Bass recipe rules for multilingual Bass requests", () => {
  const requests = [
    "Write a bassline.",
    "写一条贝斯线",
    "Schreibe eine Basslinie.",
    "Écris une ligne de basse.",
    "ベースラインを作って",
    "Crea una línea de bajo.",
    "Crea una linea di basso.",
  ];
  for (const request of requests) {
    const prompt = instrumentPromptFor(request, request);
    assert.match(prompt, /For Bass sound design or a new Bass part/, request);
    assert.doesNotMatch(prompt, /When Guitar is the selected instrument/, request);
    assert.doesNotMatch(prompt, /For Pluck sound design/, request);
  }
});

test("preserves the full playbook for ambiguous wording and the narrow tempo edit", () => {
  const ambiguous = selectWorkflowRules("Help me with the sound.");
  assert.match(ambiguous.prompt, /Making music that actually produces sound:/);
  assert.match(ambiguous.prompt, /Arranging the Set:/);
  assert.equal(ambiguous.sectionChars.full, ambiguous.prompt.length);

  const tempo = selectWorkflowRules("把速度设置为124", "tempo");
  assert.doesNotMatch(tempo.prompt, /Goals \(tasks that change the Set\):/);
  assert.doesNotMatch(tempo.prompt, /Plans \(multi-step tasks\):/);
  assert.doesNotMatch(tempo.prompt, /Making music that actually produces sound:/);
});
