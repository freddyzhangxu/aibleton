import assert from "node:assert/strict";
import { test } from "node:test";
import { historyWithTools } from "./history.js";
import type { ChatSession } from "./session.js";

const format = {
  userText: (content: string) => ({ role: "user", content }),
  assistantText: (content: string) => ({ role: "assistant", content }),
  toolRound: (actions: unknown[], id: string) => [{ role: "tools", actions, id }],
};

test("history bounds old turns while keeping the current request intact and the stored transcript unchanged", () => {
  const session: ChatSession = { id: "test", title: "test", createdAt: 0, updatedAt: 0, messages: [] };
  for (let i = 0; i < 40; i++) {
    session.messages.push({ role: "user", content: `request-${i} ` + "x".repeat(2000) });
    session.messages.push({ role: "assistant", content: `reply-${i} ` + "y".repeat(2000) });
  }
  const current = "Current request and attachment " + "z".repeat(14000);
  session.messages.push({ role: "user", content: current });
  const before = JSON.stringify(session);
  const history = historyWithTools(session, format);
  assert.ok(JSON.stringify(history).length < 60000);
  assert.deepEqual(history.at(-1), { role: "user", content: current });
  assert.ok(JSON.stringify(history).includes("request-39"));
  assert.match(JSON.stringify(history), /earlier conversation/i);
  assert.equal(JSON.stringify(session), before);
});

test("completed tool payloads omit large note arrays but preserve targets, verification, and failures", () => {
  const session: ChatSession = {
    id: "test", title: "test", createdAt: 0, updatedAt: 0,
    messages: [
      { role: "user", content: "Write bass" },
      { role: "assistant", content: "Partially done", actions: [{
        tool: "write_midi_clip",
        input: { track_index: 2, track_name: "Bass", notes: Array.from({ length: 1000 }, (_, i) => ({ pitch: 48, start: i, velocity: 100 })) },
        result: { verified: false, error: "clip changed unexpectedly", track_name: "Bass", notes: Array.from({ length: 1000 }, (_, i) => ({ pitch: 48, start: i })) },
      }] },
      { role: "user", content: "Continue" },
    ],
  };
  const history = historyWithTools(session, format);
  const serialized = JSON.stringify(history);
  assert.ok(serialized.length < 6000);
  assert.match(serialized, /clip changed unexpectedly/);
  assert.match(serialized, /Bass/);
  assert.match(serialized, /omitted/i);
  assert.match(serialized, /"verified":false/);
});

test("small histories retain their provider tool-call pairs exactly", () => {
  const session: ChatSession = { id: "t", title: "t", createdAt: 0, updatedAt: 0, messages: [
    { role: "user", content: "Set BPM" },
    { role: "assistant", content: "Done", actions: [{ tool: "set_tempo", input: { bpm: 128 }, result: { tempo: 128, verified: true } }] },
    { role: "user", content: "What changed?" },
  ] };
  assert.deepEqual(historyWithTools(session, format), [
    { role: "user", content: "Set BPM" },
    { role: "tools", actions: session.messages[1].actions, id: "hist_1_" },
    { role: "assistant", content: "Done" },
    { role: "user", content: "What changed?" },
  ]);
});
