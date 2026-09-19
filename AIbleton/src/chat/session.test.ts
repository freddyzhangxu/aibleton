import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Ctx } from "../state.js";
import { createSession, currentSession, finishChat, stripEmoji } from "./session.js";

test("stripEmoji removes common, joined, flag, and keycap Emoji", () => {
  assert.equal(stripEmoji("Plain text 123 # * ♪"), "Plain text 123 # * ♪");
  assert.equal(stripEmoji("完成 👍🏽 👩🏽‍💻 ❤️ 🇨🇳 1️⃣"), "完成     ");
});

test("finishChat stores and returns an Emoji-free assistant reply only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibleton-session-test-"));
  const context = { environment: { storageDirectory: dir } } as Ctx;
  try {
    createSession();
    currentSession().messages.push({ role: "user", content: "保留 👋" });
    const result = finishChat(context, [], "已完成 ✅，请试听 🎧");
    assert.equal(result.reply, "已完成 ，请试听 ");
    assert.equal(currentSession().messages.at(-1)?.content, "已完成 ，请试听 ");
    assert.equal(currentSession().messages[0]?.content, "保留 👋");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finishChat persists a receipt only when a successful Set mutation ran", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibleton-session-test-"));
  const context = { environment: { storageDirectory: dir } } as Ctx;
  try {
    createSession();
    finishChat(context, [{ tool: "write_midi_clip", input: {}, result: {} }], "Done");
    assert.deepEqual(currentSession().messages.at(-1)?.receipt?.tools, ["write_midi_clip"]);
    finishChat(context, [{ tool: "analyze_song", input: {}, result: {} }], "Read only");
    assert.equal(currentSession().messages.at(-1)?.receipt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
