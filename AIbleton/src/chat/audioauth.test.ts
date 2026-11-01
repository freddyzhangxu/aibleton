import assert from "node:assert/strict";
import test from "node:test";
import { audioGenerationAuthorized } from "./audioauth.js";

test("song creation and audio assets default to Live without specifying an AI generator", () => {
  for (const text of [
    "制作一首布鲁斯", "生成一首布鲁斯", "帮我用AIbleton制作一首布鲁斯",
    "写一条贝斯线", "生成一段音频", "生成一个布鲁斯loop", "Make a blues song",
    "Generate an audio loop", "Create a sample", "用 Ableton 制作一首爵士",
    "AI 音频生成设置在哪里", "What is AI audio generation?", "继续", "好的",
  ]) assert.equal(audioGenerationAuthorized(text), false, text);
});

test("all ordinary creation verbs use Live even when addressed to the AI assistant", () => {
  for (const verb of ["制作", "创作", "編寫", "编写", "写", "寫", "做", "作曲", "编曲", "谱写", "創作"]) {
    for (const prefix of ["帮我", "请 AI 帮我", "使用 AI "]) {
      const text = `${prefix}${verb}一首布鲁斯`;
      assert.equal(audioGenerationAuthorized(text), false, text);
    }
  }
  for (const text of ["AI, write a blues song", "Use AI to compose a song", "Use AI to produce music"]) {
    assert.equal(audioGenerationAuthorized(text), false, text);
  }
});

test("explicit AI audio methods and configured generator names authorize generation", () => {
  for (const text of [
    "用AI生成一段布鲁斯音频", "请生成AI音频",
    "Use AI to generate an audio loop", "Generate AI audio", "Create an AI-generated blues song",
    "用 MiniMax 生成一首布鲁斯", "用 MiniMax 做一首布鲁斯", "使用音频生成制作一首布鲁斯",
    "Use ElevenLabs to create a blues loop", "Generate a song with Stable Audio",
    "Erzeuge mit KI eine Audiodatei", "Génère un audio avec IA", "Genera audio con IA",
    "Genera una canzone con IA", "AIでブルースの音声を生成して",
  ]) assert.equal(audioGenerationAuthorized(text), true, text);
});

test("negated generation requests never authorize the paid tool", () => {
  for (const text of [
    "不要用AI生成音频，用Ableton制作", "不用 MiniMax，直接制作布鲁斯",
    "Don't generate AI audio; make it in Live", "Do not use ElevenLabs to generate a song",
    "No AI audio generation", "不要生成音频", "AIで音声を生成しないで",
  ]) assert.equal(audioGenerationAuthorized(text), false, text);
});

test("short consent applies only to an immediately preceding explicit generation offer", () => {
  const offer = "本地没有合适采样，要用 AI 生成一段音频吗？";
  assert.equal(audioGenerationAuthorized("可以", offer), true);
  assert.equal(audioGenerationAuthorized("好的，用音频生成吧", offer), true);
  assert.equal(audioGenerationAuthorized("Yes", "No local sample matched. Shall I use AI to generate an audio loop?"), true);
  assert.equal(audioGenerationAuthorized("不，直接在Live里制作", offer), false);
  assert.equal(audioGenerationAuthorized("制作一首布鲁斯", offer), false);
  assert.equal(audioGenerationAuthorized("好的，制作一首布鲁斯", offer), false);
  assert.equal(audioGenerationAuthorized("好的，直接在Ableton里制作", offer), false);
  assert.equal(audioGenerationAuthorized("继续", "已经生成了AI音频。"), false);
  assert.equal(audioGenerationAuthorized("可以", "要创建一条MIDI轨道吗？"), false);
});
