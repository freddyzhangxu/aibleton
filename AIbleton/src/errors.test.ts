/**
 * errors.test.ts — raw provider/Node errors must surface as user-actionable
 * messages ("what happened + what to do"), never as bare API/Node text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionableError,
  friendlyApiError,
  friendlyAudioError,
  friendlyToolError,
  isFriendlyError,
  settingsPath,
} from "./errors.js";

const AI_ZH = settingsPath("zh", "ai");
const AI_EN = settingsPath("en", "ai");

test("missing-key class errors point at Settings → AI 配置", () => {
  const e = friendlyApiError({
    what: "Claude",
    settings: AI_ZH,
    status: 401,
    raw: "invalid x-api-key",
    language: "zh",
  });
  assert.match(e.message, /API Key/);
  assert.match(e.message, /设置（齿轮）→ AI 配置/);
});

test("invalid model name names the model and the settings path", () => {
  const e = friendlyApiError({
    what: "Gemini",
    settings: AI_EN,
    status: 404,
    raw: "models/gemini-9-pro is not found for API version",
    model: "gemini-9-pro",
    language: "en",
  });
  assert.match(e.message, /gemini-9-pro/);
  assert.match(e.message, /Settings \(gear icon\) → AI Provider/);
});

test("quota errors say the account is out of quota", () => {
  const e = friendlyApiError({
    what: "Codex",
    settings: AI_EN,
    status: 429,
    raw: "You exceeded your current quota, please check your plan and billing details",
    language: "en",
  });
  assert.match(e.message, /out of quota/i);
});

test("rate-limit errors tell the user to wait and retry", () => {
  const e = friendlyApiError({
    what: "Claude",
    settings: AI_ZH,
    raw: "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request. Request id: 02178",
    language: "zh",
  });
  assert.match(e.message, /太频繁|限流/);
  assert.match(e.message, /再试/);
});

test("raw Node network errors become a connectivity hint, not 'fetch failed'", () => {
  const e = friendlyApiError({
    what: "Claude",
    settings: AI_ZH,
    raw: "fetch failed",
    language: "zh",
  });
  assert.doesNotMatch(e.message, /^fetch failed$/);
  assert.match(e.message, /网络/);
  assert.match(e.message, /重试/);
});

test("proxy failures get the proxy-specific hint", () => {
  const e = friendlyApiError({
    what: "Gemini",
    settings: AI_ZH,
    raw: "代理连接超时 (127.0.0.1:7890)",
    language: "zh",
  });
  assert.match(e.message, /代理/);
});

test("the stop signal passes through unmapped", () => {
  const e = friendlyApiError({ what: "Claude", settings: AI_ZH, raw: "请求已停止", language: "zh" });
  assert.equal(e.message, "请求已停止");
});

test("unknown errors keep the raw text but add where to look", () => {
  const e = friendlyApiError({
    what: "Stable Audio",
    settings: settingsPath("zh", "audio"),
    status: 422,
    raw: "prompt too long",
    language: "zh",
  });
  assert.match(e.message, /prompt too long/);
  assert.match(e.message, /设置（齿轮）→ 音频生成/);
});

test("audio errors route to 设置 → 音频生成", () => {
  const e = friendlyAudioError("MiniMax", 401, "invalid api key", "zh");
  assert.match(e.message, /音频生成/);
});

test("mapped errors are marked so outer catches never double-wrap", () => {
  const e = friendlyApiError({ what: "Claude", settings: AI_ZH, status: 401, raw: "x", language: "zh" });
  assert.ok(isFriendlyError(e));
  assert.ok(isFriendlyError(actionableError("手写可行动错误")));
  assert.ok(!isFriendlyError(new Error("raw")));
});

test("deleted Live objects tell the model to re-fetch the song state", () => {
  const msg = friendlyToolError(new Error("Invalid object reference"));
  assert.match(msg, /get_song_overview/);
  assert.match(msg, /已不存在|被删除|失效/);
});

test("unknown tool errors pass through untouched", () => {
  assert.equal(friendlyToolError(new Error("轨道序号 9 无效")), "轨道序号 9 无效");
  assert.equal(friendlyToolError("plain string"), "plain string");
});
