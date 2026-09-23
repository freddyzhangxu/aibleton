import { test } from "node:test";
import assert from "node:assert/strict";

import {
  languageCorrectionPrompt,
  normalizeLanguage,
  replyNeedsLanguageCorrection,
  resolveReplyLanguage,
  resolveTurnLanguage,
} from "./language.js";

test("detects all seven supported message languages", () => {
  const cases = [
    ["请把鼓声调大一点", "zh"],
    ["Please make the kick harder and keep the tempo", "en"],
    ["Bitte mache die Bassspur lauter und behalte das Tempo", "de"],
    ["Crée une ligne de basse et garde le tempo", "fr"],
    ["キックをもっと強くしてください", "ja"],
    ["Por favor, haz el bajo más fuerte y mantén el tempo", "es"],
    ["Per favore, crea una linea di basso e mantieni il tempo", "it"],
  ] as const;
  for (const [text, language] of cases) {
    const resolved = resolveReplyLanguage({ text, panelLanguage: "en" });
    assert.equal(resolved.language, language, text);
    assert.equal(resolved.source, "message", text);
  }
});

test("message language beats panel language; Live language is not an input", () => {
  const turn = resolveTurnLanguage({
    text: "Por favor, crea una guitarra y un órgano",
    panelLanguage: "en",
  });
  assert.equal(turn.uiLanguage, "en");
  assert.equal(turn.replyLanguage, "es");
  assert.equal(turn.searchLanguage, "es");
  assert.equal(turn.source, "message");
});

test("ambiguous content falls back to the panel, then English", () => {
  assert.deepEqual(
    resolveReplyLanguage({ text: "120 BPM", panelLanguage: "es" }),
    { language: "es", source: "panel", confidence: 1 },
  );
  assert.deepEqual(
    resolveReplyLanguage({ text: "120 BPM", panelLanguage: "pt-BR" }),
    { language: "en", source: "default", confidence: 1 },
  );
});

test("script rules distinguish Japanese kana from Han-only Chinese", () => {
  assert.equal(resolveReplyLanguage({ text: "音をもっと強く", panelLanguage: "en" }).language, "ja");
  assert.equal(resolveReplyLanguage({ text: "声音更强", panelLanguage: "en" }).language, "zh");
});

test("URLs, code, filenames and music tokens do not decide the language", () => {
  const text = "https://example.com `set_goal` /tmp/Kick.wav 128 BPM C minor";
  assert.equal(resolveReplyLanguage({ text, panelLanguage: "fr" }).language, "fr");
});

test("normalizes regional and unsupported language codes", () => {
  assert.equal(normalizeLanguage("es-MX"), "es");
  assert.equal(normalizeLanguage("JA_jp"), "ja");
  assert.equal(normalizeLanguage("pt-BR"), "en");
});

test("detects a confident final-reply mismatch and creates a bounded rewrite prompt", () => {
  assert.equal(replyNeedsLanguageCorrection("Done. The guitar track is ready.", "es"), true);
  assert.equal(replyNeedsLanguageCorrection("Listo. La pista de guitarra está preparada.", "es"), false);
  assert.equal(replyNeedsLanguageCorrection("120 BPM", "es"), false);
  assert.match(languageCorrectionPrompt("es"), /Spanish \(es\)/);
  assert.match(languageCorrectionPrompt("es"), /Do not call any tools/);
});

test("detects a later Chinese paragraph inside an otherwise Japanese reply", () => {
  assert.equal(
    replyNeedsLanguageCorrection(
      "分析を開始しました。ここから結果を説明します。\n这里是中文回复，后面继续说明分析结果。",
      "ja",
    ),
    true,
  );
  assert.equal(replyNeedsLanguageCorrection("分析を開始しました。結果を日本語で説明します。", "ja"), false);
});

test("ignores short Han-only labels and non-prose content for Japanese", () => {
  assert.equal(replyNeedsLanguageCorrection("分析結果", "ja"), false);
  assert.equal(replyNeedsLanguageCorrection("`set_goal`\n120 BPM\nTrack 1 (Pad)", "ja"), false);
});
