import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { listModels } from "./testconn.js";
import { toolHooks } from "../state.js";

function localFiles(t: TestContext, files: Record<string, unknown>) {
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const name = String(file).replace(/\\/g, "/");
    for (const [suffix, content] of Object.entries(files)) {
      if (name.endsWith(suffix)) return JSON.stringify(content);
    }
    return Reflect.apply(original, fs, [file, ...args]);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("ChatGPT Codex lists visible models from the CLI cache without generation calls", async (t) => {
  localFiles(t, {
    "/.codex/auth.json": { tokens: { access_token: "test-token" } },
    "/.codex/models_cache.json": { models: [
      { slug: "gpt-6.1-sol", visibility: "list" },
      { slug: "gpt-6-astra", visibility: "list" },
      { slug: "internal-model", visibility: "hide" },
      { slug: "gpt-6.1-sol", visibility: "list" },
      { slug: 42, visibility: "list" },
    ] },
  });
  const original = toolHooks.getManualConfig;
  toolHooks.getManualConfig = () => ({ authToken: "test-token", chatgpt: true });
  t.after(() => { toolHooks.getManualConfig = original; });
  const result = await listModels("codex");
  assert.deepEqual(result.models, ["gpt-6.1-sol", "gpt-6-astra"]);
});

for (const catalog of [null, { data: [{ id: "kimi-k3" }, { id: "catalog-model" }] }]) {
  test(`Claude merges configured model mappings when catalog is ${catalog ? "available" : "unsupported"}`, async (t) => {
    const server = createServer((req, res) => {
      assert.equal(req.method, "GET", "listing must never generate tokens");
      assert.equal(req.url, "/api/plan/v1/models");
      res.writeHead(catalog ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(catalog ?? {}));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api/plan`;
    localFiles(t, { "/.claude/settings.json": { env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
    } } });
    const original = toolHooks.getManualConfig;
    toolHooks.getManualConfig = () => ({ baseUrl, apiKey: "test-key" });
    t.after(() => { toolHooks.getManualConfig = original; });
    const result = await listModels("claude");
    assert.deepEqual(new Set(result.models), new Set([
      "kimi-k3", "glm-5.3", "glm-5.3-flash", ...(catalog ? ["catalog-model"] : []),
    ]));
    assert.equal(result.models.length, new Set(result.models).size);
  });
}

test("Claude keeps local model mappings ahead when the UI overrides the CLI endpoint", async (t) => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  localFiles(t, { "/.claude/settings.json": { env: {
    ANTHROPIC_BASE_URL: "https://another-relay.example",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "another-relay-model",
  } } });
  const original = toolHooks.getManualConfig;
  toolHooks.getManualConfig = () => ({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
  t.after(() => { toolHooks.getManualConfig = original; });
  const result = await listModels("claude");
  assert.deepEqual(result.models, ["another-relay-model"]);
  assert.match(result.detail ?? "", /404/);
});

test("Gemini full catalog follows pagination and keeps filtering metadata from later pages", async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    const url = new URL(req.url!, "http://127.0.0.1");
    requests.push(url.searchParams.get("pageToken") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(url.searchParams.get("pageToken") ? { models: [
      { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-flash-tts", supportedGenerationMethods: ["generateContent"] },
    ] } : { models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    ], nextPageToken: "next-page" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const original = toolHooks.getManualConfig;
  toolHooks.getManualConfig = () => ({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" });
  t.after(() => { toolHooks.getManualConfig = original; });
  const result = await listModels("gemini");
  assert.deepEqual(result.models, ["gemini-2.5-flash", "gemini-3.1-pro-preview", "gemini-flash-tts"]);
  assert.deepEqual(result.suggestedModels, ["gemini-3.1-pro-preview", "gemini-2.5-flash"]);
  assert.deepEqual(requests, ["", "next-page"]);
});
