/**
 * testconn.test.ts — the settings-page connection probe's pure classifiers:
 * auth/status mapping and model-list membership. Wrong classifications here
 * show the user a green "Connected" over a broken setup (or vice versa).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAuth, fromModelList, modelInList, parseModelIds } from "./testconn.js";

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
