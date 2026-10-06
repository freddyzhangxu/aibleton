/**
 * testconn.test.ts — the settings-page connection probe's pure classifiers:
 * auth/status mapping and model-list membership, plus the Claude relay
 * probe's quick/full split. Wrong classifications here show the user a green
 * "Connected" over a broken setup (or vice versa).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { classifyAuth, fromModelList, modelInList, parseModelIds, pickerModelIds, testConnection } from "./testconn.js";
import { toolHooks } from "../state.js";

test("classifyAuth: only 401/403 mean the credentials were rejected", () => {
  assert.equal(classifyAuth(401), "auth_expired");
  assert.equal(classifyAuth(403), "auth_expired");
  assert.equal(classifyAuth(200), null);
  assert.equal(classifyAuth(404), null);
  assert.equal(classifyAuth(429), null);
  assert.equal(classifyAuth(500), null);
});

test("parseModelIds: OpenAI/Anthropic {data:[{id}]} shape", () => {
  const body = JSON.stringify({ object: "list", data: [{ id: "gpt-5-codex" }, { id: "gpt-5" }] });
  assert.deepEqual(parseModelIds(body), ["gpt-5-codex", "gpt-5"]);
});

test("parseModelIds: Gemini {models:[{name}]} shape", () => {
  const body = JSON.stringify({ models: [{ name: "models/gemini-flash-latest" }, {}] });
  assert.deepEqual(parseModelIds(body), ["models/gemini-flash-latest"]);
});

test("parseModelIds: junk in, empty list out (never throws)", () => {
  assert.deepEqual(parseModelIds("not json"), []);
  assert.deepEqual(parseModelIds("{}"), []);
  assert.deepEqual(parseModelIds('{"data":"nope"}'), []);
});

test("modelInList: exact match and undated-alias → dated variant", () => {
  const ids = ["claude-sonnet-5-20260101", "claude-opus-4-1"];
  assert.equal(modelInList(ids, "claude-sonnet-5-20260101"), true);
  assert.equal(modelInList(ids, "claude-sonnet-5"), true);
  assert.equal(modelInList(ids, "claude-haiku-4-5"), false);
});

test("modelInList: Gemini models/ prefix", () => {
  const ids = ["models/gemini-flash-latest", "models/gemini-3-pro"];
  assert.equal(modelInList(ids, "gemini-flash-latest"), true);
  assert.equal(modelInList(ids, "gemini-2.5-pro"), false);
});

test("modelInList: an unrelated longer id is not a match", () => {
  // "gpt-5-codex-mini" must not cover a configured "gpt-5-codex".
  assert.equal(modelInList(["gpt-5-codex-mini"], "gpt-5-codex"), false);
});

test("fromModelList: official endpoint — a missing model is unavailable", () => {
  const body = JSON.stringify({ data: [{ id: "kimi-k3" }] });
  assert.equal(fromModelList(body, "claude-sonnet-5", true).status, "model_unavailable");
  assert.equal(fromModelList(body, "kimi-k3", true).status, "connected");
});

test("fromModelList: relay — a missing model degrades to an advisory, not a failure", () => {
  // Third-party Anthropic relays list their upstream's models but map/ignore
  // the model field per request; "not in list" must not read as unavailable.
  const body = JSON.stringify({ data: [{ id: "kimi-k3" }] });
  const r = fromModelList(body, "claude-sonnet-5", false);
  assert.equal(r.status, "connected");
  assert.match(r.detail ?? "", /not in the list/);
});

// A relay's Anthropic-compatible catalog can omit an alias chat still maps
// (ark serving "kimi-k3"). The quick check stays advisory; only the explicit
// button spends the 1-token generation probe to prove it.
test("explicit Claude connection test probes generation when a relay omits the model", async () => {
  let probes = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "upstream-model" }] }));
    } else {
      probes++;
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const getManualConfig = toolHooks.getManualConfig;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    toolHooks.getManualConfig = () => ({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authToken: "relay-key",
      model: "kimi-k3",
    });
    const quick = await testConnection("claude", false);
    assert.equal(probes, 0, "opening settings must not spend generation tokens");
    assert.equal(quick.status, "connected");
    assert.match(quick.detail ?? "", /not in the list/);
    const full = await testConnection("claude", true);
    assert.equal(full.status, "connected");
    assert.equal(probes, 1, "an explicit test must prove generation works");
    // Once the server has recorded the successful probe, the quick check
    // stops nudging on subsequent launches.
    const again = await testConnection("claude", false, ["kimi-k3"]);
    assert.equal(again.status, "connected");
    assert.equal(again.detail, undefined, "a verified relay model stays a plain Connected");
    assert.equal(probes, 1, "verified quick checks still spend no tokens");
  } finally {
    toolHooks.getManualConfig = getManualConfig;
    server.close();
    await once(server, "close");
  }
});

test("pickerModelIds: Gemini keeps only chat models, without the models/ prefix", () => {
  const body = JSON.stringify({
    models: [
      { name: "models/gemini-flash-latest" },
      { name: "models/gemini-3-pro" },
      { name: "models/text-embedding-004" },
      { name: "models/aqa" },
      { name: "tunedModels/my-tune" },
    ],
  });
  assert.deepEqual(pickerModelIds("gemini", body), ["gemini-flash-latest", "gemini-3-pro"]);
});

test("pickerModelIds: other providers pass the catalog through untouched", () => {
  const body = JSON.stringify({ data: [{ id: "kimi-k3" }, { id: "gpt-5.6-sol" }] });
  assert.deepEqual(pickerModelIds("claude", body), ["kimi-k3", "gpt-5.6-sol"]);
  assert.deepEqual(pickerModelIds("custom", body), ["kimi-k3", "gpt-5.6-sol"]);
});
