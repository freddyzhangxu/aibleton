import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCustom, customReasoning } from "./custom.js";
import { toolHooks } from "../../state.js";

// Catch parsing failures that hide the HTTP status or accept invalid success bodies.
for (const fixture of [
  { status: 404, body: "", expected: /404/, absent: /Unexpected end/ },
  { status: 502, body: "<html>Bad Gateway</html>", expected: /temporarily overloaded/, absent: /Unexpected token/ },
  { status: 401, body: "", expected: /API key is invalid or expired/, absent: /Unexpected end/ },
  { status: 200, body: "", expected: /empty response body/i, absent: /Unexpected end/ },
  { status: 200, body: '{"choices":', expected: /invalid JSON/i, absent: /Unexpected end/ },
  { status: 200, body: "null", expected: /incomplete.*response/i, absent: /Cannot read/ },
  { status: 200, body: "{}", expected: /incomplete.*response/i, absent: /not initialized/ },
  {
    status: 200, contentType: "text/event-stream",
    body: 'data: {"error":{"message":"model overloaded"}}\n\n',
    expected: /temporarily overloaded/, absent: /Unexpected token/,
  },
]) {
  test(`Custom reports HTTP ${fixture.status} with body ${JSON.stringify(fixture.body)}`, async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.writeHead(fixture.status, { "content-type": "contentType" in fixture ? fixture.contentType as string : "application/json" });
      res.end(fixture.body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const debugLog = toolHooks.debugLog;
    toolHooks.debugLog = () => {};
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(chatCustom({} as never, {
        provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        authToken: "", model: "test-model", fromLocal: false,
      }, { language: "en" }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, fixture.expected);
        assert.doesNotMatch(error.message, fixture.absent);
        return true;
      });
    } finally {
      toolHooks.debugLog = debugLog;
      server.close();
      await once(server, "close");
    }
  });
}

// The thinking switch rides on the ark-style `thinking` field, mapped only for
// documented endpoint/model combinations — strict relays (xAI) get verbatim bodies.
test("Custom maps reasoning controls only for documented endpoints", () => {
  const base = { provider: "custom", authToken: "", fromLocal: false } as const;
  const ark = { ...base, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-1-pro-250615" };
  assert.deepEqual(customReasoning({ ...ark, effort: "off" }), { thinking: { type: "disabled" } });
  assert.deepEqual(customReasoning({ ...ark, effort: "on" }), { thinking: { type: "enabled" } });
  // A thinking-switch model defaults to off when no effort was picked.
  assert.deepEqual(customReasoning(ark), { thinking: { type: "disabled" } });
  // Ark Kimi K3 always thinks (no thinking switch) but exposes the model-native
  // levels — with no default, so an unpicked effort keeps the body verbatim.
  assert.deepEqual(customReasoning({ ...ark, model: "kimi-k3-250711" }), {});
  assert.deepEqual(customReasoning({ ...ark, model: "kimi-k3-250711", effort: "low" }), { reasoning_effort: "low" });
  assert.deepEqual(customReasoning({ ...ark, model: "kimi-k3-250711", effort: "max" }), { reasoning_effort: "max" });
  assert.deepEqual(customReasoning({ ...ark, model: "kimi-k3-250711", effort: "on" }), {});
  const kimi = { ...base, baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k3-0711-preview" };
  assert.deepEqual(customReasoning({ ...kimi, effort: "high" }), { reasoning_effort: "high" });
  assert.deepEqual(customReasoning(kimi), { reasoning_effort: "low" });
  // Unknown relays use the generic OpenAI-spec levels: a user-picked level
  // rides along, but no default is invented and out-of-spec values drop.
  const local = { ...base, baseUrl: "http://127.0.0.1:8000/v1", model: "test-model" };
  assert.deepEqual(customReasoning(local), {});
  assert.deepEqual(customReasoning({ ...local, effort: "low" }), { reasoning_effort: "low" });
  assert.deepEqual(customReasoning({ ...local, effort: "medium" }), { reasoning_effort: "medium" });
  assert.deepEqual(customReasoning({ ...local, effort: "high" }), { reasoning_effort: "high" });
  assert.deepEqual(customReasoning({ ...local, effort: "on" }), {});
  assert.deepEqual(customReasoning({ ...local, effort: "max" }), {});
  assert.deepEqual(customReasoning({ ...base, baseUrl: "not a url", model: "test-model", effort: "low" }), { reasoning_effort: "low" });
  assert.deepEqual(customReasoning({ ...base, baseUrl: "not a url", model: "test-model", effort: "on" }), {});
});

test("Custom streams by default and sends no vendor fields to an unknown endpoint", async () => {
  let capturedBody = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) capturedBody += chunk;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const debugLog = toolHooks.debugLog;
  toolHooks.debugLog = () => {};
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const storageDirectory = mkdtempSync(join(tmpdir(), "aibleton-custom-"));
    const result = await chatCustom(
      { environment: { storageDirectory } } as never,
      {
        provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        authToken: "", model: "test-model", fromLocal: false, effort: "on",
      },
      { language: "en" },
    );
    assert.equal(result.reply, "done");
    const body = JSON.parse(capturedBody) as {
      stream?: boolean;
      thinking?: { type?: string };
      reasoning_effort?: string;
    };
    assert.equal(body.stream, true);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    toolHooks.debugLog = debugLog;
    server.close();
    await once(server, "close");
  }
});

// Regression: ark 400s on the round-1 echo when a stream-aggregated tool_call
// lacks `type: "function"` ("missing messages.tool_calls.type parameter").
test("Custom replays stream-aggregated tool_calls with type:function in the next round", async () => {
  const capturedBodies: string[] = [];
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    capturedBodies.push(body);
    requestCount++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "get_song_overview", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      ];
      res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n");
      return;
    }
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const debugLog = toolHooks.debugLog;
  toolHooks.debugLog = () => {};
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const storageDirectory = mkdtempSync(join(tmpdir(), "aibleton-custom-"));
    const result = await chatCustom(
      { environment: { storageDirectory } } as never,
      {
        provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        authToken: "", model: "test-model", fromLocal: false,
      },
      { language: "en" },
    );
    assert.equal(result.reply, "done");
    assert.equal(capturedBodies.length, 2, "the tool round must trigger a second request");
    const round1 = JSON.parse(capturedBodies[1]) as {
      messages: {
        role: string;
        tool_calls?: { id?: string; type?: string; function?: { name?: string } }[];
        tool_call_id?: string;
      }[];
    };
    const echo = round1.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.ok(echo, "round 1 must echo the assistant tool_calls message");
    assert.equal(echo.tool_calls?.[0]?.type, "function");
    assert.equal(echo.tool_calls?.[0]?.function?.name, "get_song_overview");
    const toolReply = round1.messages.find((m) => m.role === "tool");
    assert.equal(toolReply?.tool_call_id, "call_x");
  } finally {
    toolHooks.debugLog = debugLog;
    server.close();
    await once(server, "close");
  }
});
