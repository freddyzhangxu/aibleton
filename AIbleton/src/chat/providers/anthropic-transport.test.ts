import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { requestAnthropicRound } from "./anthropic-transport.js";

test("requests a streamed Claude round and returns its complete message", async () => {
  let posted: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/messages");
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    posted = JSON.parse(body) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"content":[],"stop_reason":null}}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}\n\n');
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await requestAnthropicRound(
      `http://127.0.0.1:${address.port}/v1/messages`,
      { "content-type": "application/json" },
      { model: "claude-test", max_tokens: 128, messages: [] },
      null,
    );
    assert.equal(posted?.stream, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("accepts a relay that returns JSON despite a stream request", async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume body */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "Relay reply" }], stop_reason: "end_turn" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await requestAnthropicRound(
      `http://127.0.0.1:${address.port}/v1/messages`, {}, { model: "relay-test" }, null,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.content, [{ type: "text", text: "Relay reply" }]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
