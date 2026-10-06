import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Ctx } from "../state.js";
import { historyWithTools } from "./history.js";
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

test("replays an executable set_plan once without duplicating its internal steps", () => {
  const transcript = historyWithTools({
    id: "test",
    title: "test",
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { role: "user", content: "Create a bass clip" },
      {
        role: "assistant",
        content: "Done",
        actions: [
          { tool: "set_plan", input: { execute: true }, result: { execution: { completed_step_ids: ["track", "clip"] } } },
          { tool: "create_midi_track", input: { name: "Bass" }, result: { created: "Bass" }, planStep: true },
          { tool: "write_midi_clip", input: { track_name: "Bass" }, result: { noteCount: 16 }, planStep: true },
          { tool: "analyze_song", input: {}, result: { bars: 8 } },
        ],
      },
    ],
  }, {
    userText: (text) => `user:${text}`,
    assistantText: (text) => `assistant:${text}`,
    toolRound: (actions) => actions.map((action) => `tool:${action.tool}`),
  });

  assert.deepEqual(transcript, [
    "user:Create a bass clip",
    "tool:set_plan",
    "tool:analyze_song",
    "assistant:Done",
  ]);
});
