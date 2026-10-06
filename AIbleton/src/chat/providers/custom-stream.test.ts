import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readChatCompletionsStream } from "./custom-stream.js";

async function* streamOf(chunks: (string | Buffer)[]): AsyncIterable<Buffer> {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  }
}

function sseLines(...events: (unknown | string)[]): string[] {
  return [
    ...events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`),
    "data: [DONE]\n\n",
  ];
}

function deltaEvent(delta: Record<string, unknown>, finishReason?: string) {
  return { choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] };
}

test("aggregates content deltas into the non-streaming message shape", async () => {
  const data = await readChatCompletionsStream(streamOf(sseLines(
    deltaEvent({ role: "assistant", content: "" }),
    deltaEvent({ content: "你好" }),
    deltaEvent({ content: "，世界" }, "stop"),
  )));
  const msg = data.choices?.[0]?.message;
  assert.equal(msg?.content, "你好，世界");
  assert.equal(msg?.tool_calls, undefined);
});

test("decodes multi-byte UTF-8 split across chunk boundaries", async () => {
  const payload = sseLines(deltaEvent({ content: "深色 techno 音色" }, "stop"))[0];
  const bytes = Buffer.from(payload, "utf8");
  // Split inside a multibyte CJK character so naive chunk.toString would corrupt it.
  const cut = bytes.indexOf(Buffer.from("深", "utf8")) + 1;
  const data = await readChatCompletionsStream(streamOf([
    bytes.subarray(0, cut),
    bytes.subarray(cut),
    "data: [DONE]\n\n",
  ]));
  assert.equal(data.choices?.[0]?.message?.content, "深色 techno 音色");
});

test("aggregates parallel tool_calls with arguments chunked across deltas", async () => {
  const data = await readChatCompletionsStream(streamOf(sseLines(
    deltaEvent({ tool_calls: [{ index: 0, id: "call_a", function: { name: "set_tempo", arguments: "" } }] }),
    deltaEvent({ tool_calls: [{ index: 0, function: { arguments: "{\"bpm\":" } }] }),
    deltaEvent({ tool_calls: [{ index: 1, id: "call_b", function: { name: "get_tracks", arguments: "{}" } }] }),
    deltaEvent({ tool_calls: [{ index: 0, function: { arguments: "128}" } }] }, "tool_calls"),
  )));
  const calls = data.choices?.[0]?.message?.tool_calls;
  assert.deepEqual(calls, [
    { id: "call_a", type: "function", function: { name: "set_tempo", arguments: "{\"bpm\":128}" } },
    { id: "call_b", type: "function", function: { name: "get_tracks", arguments: "{}" } },
  ]);
});

test("keeps reasoning_content out of the visible reply", async () => {
  const data = await readChatCompletionsStream(streamOf(sseLines(
    deltaEvent({ reasoning_content: "先想清楚……" }),
    deltaEvent({ reasoning_content: "再回答。" }),
    deltaEvent({ content: "答案" }, "stop"),
  )));
  assert.equal(data.choices?.[0]?.message?.content, "答案");
});

test("throws the gateway's own message on a mid-stream error event", async () => {
  await assert.rejects(
    readChatCompletionsStream(streamOf([
      `data: ${JSON.stringify(deltaEvent({ content: "partial" }))}\n\n`,
      `data: ${JSON.stringify({ error: { message: "model overloaded" } })}\n\n`,
    ])),
    /model overloaded/,
  );
});

test("surfaces a plain JSON error body that ignores the SSE request", async () => {
  await assert.rejects(
    readChatCompletionsStream(streamOf([JSON.stringify({ error: { message: "bad api key" } })])),
    /bad api key/,
  );
});

test("surfaces a non-JSON body when no SSE events arrive", async () => {
  await assert.rejects(
    readChatCompletionsStream(streamOf(["<html>Bad Gateway</html>"])),
    /non-SSE response.*Bad Gateway/,
  );
});

test("rejects an empty stream instead of returning a blank message", async () => {
  await assert.rejects(
    readChatCompletionsStream(streamOf([])),
    /Connection dropped/,
  );
});

test("accepts a stream that drops the trailing [DONE]", async () => {
  const logs: string[] = [];
  const data = await readChatCompletionsStream(
    streamOf([`data: ${JSON.stringify(deltaEvent({ content: "完整回答" }, "stop"))}\n\n`]),
    (line) => logs.push(line),
  );
  assert.equal(data.choices?.[0]?.message?.content, "完整回答");
  assert.ok(logs.some((line) => line.includes("no [DONE]")));
});

test("ignores usage-only tail chunks and keepalive comments", async () => {
  const data = await readChatCompletionsStream(streamOf([
    ": keepalive\n\n",
    `data: ${JSON.stringify(deltaEvent({ content: "答" }, "stop"))}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 42 } })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  assert.equal(data.choices?.[0]?.message?.content, "答");
});

test("synthesizes a tool_call id when the gateway never sends one", async () => {
  const data = await readChatCompletionsStream(streamOf(sseLines(
    deltaEvent({ tool_calls: [{ index: 0, function: { name: "get_tracks", arguments: "{}" } }] }, "tool_calls"),
  )));
  const calls = data.choices?.[0]?.message?.tool_calls;
  assert.equal(calls?.[0]?.id, "call_0");
  assert.equal(calls?.[0]?.type, "function");
  assert.equal(calls?.[0]?.function?.name, "get_tracks");
});
