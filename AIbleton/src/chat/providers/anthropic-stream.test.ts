import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { readAnthropicStream } from "./anthropic-stream.js";

function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* chunks(bytes: Buffer, cuts: number[]): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const end of cuts) {
    yield bytes.subarray(offset, end);
    offset = end;
  }
  yield bytes.subarray(offset);
}

test("rebuilds text and tool input from split SSE and UTF-8 chunks", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("ping", { type: "ping" }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "制作音" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "轨" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "set_tempo", input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"tempo\":" } }),
    event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " 128}" } }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  const bytes = Buffer.from(wire);
  const utf8 = bytes.indexOf(Buffer.from("音"));
  const result = await readAnthropicStream(chunks(bytes, [1, 13, utf8 + 1, utf8 + 2, bytes.length - 2]));

  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.content, [
    { type: "text", text: "制作音轨" },
    { type: "tool_use", id: "toolu_1", name: "set_tempo", input: { tempo: 128 } },
  ]);
});

test("preserves thinking text and signature for tool continuation", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the beat." } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_123" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");

  assert.deepEqual((await readAnthropicStream(chunks(Buffer.from(wire), [17, 29]))).content, [
    { type: "thinking", thinking: "Plan the beat.", signature: "sig_123" },
  ]);
});

test("surfaces an SSE error instead of accepting partial tool output", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "set_tempo", input: {} } }),
    event("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
  ].join("");
  await assert.rejects(readAnthropicStream(chunks(Buffer.from(wire), [])), /overloaded_error.*Overloaded/);
});

test("rejects a dropped stream before message_stop", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
  ].join("");
  await assert.rejects(readAnthropicStream(chunks(Buffer.from(wire), [])), /before message_stop/);
});

test("rejects malformed tool JSON instead of executing an empty input", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "set_tempo", input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"tempo\":" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  await assert.rejects(readAnthropicStream(chunks(Buffer.from(wire), [])), /tool input JSON/);
});

test("keeps a truncated final tool block for the max_tokens recovery path", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "set_tempo", input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"tempo\":" } }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  const result = await readAnthropicStream(chunks(Buffer.from(wire), []));
  assert.equal(result.stop_reason, "max_tokens");
  assert.deepEqual(result.content, [
    { type: "text", text: "Working" },
    { type: "tool_use", id: "toolu_2", name: "set_tempo", input: {} },
  ]);
});

test("rejects a stream with a missing content block index", async () => {
  const wire = [
    event("message_start", { type: "message_start", message: { content: [], stop_reason: null } }),
    event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "hello" } }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  await assert.rejects(readAnthropicStream(chunks(Buffer.from(wire), [])), /complete content/);
});
