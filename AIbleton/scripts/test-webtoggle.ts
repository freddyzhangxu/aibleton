/**
 * End-to-end test of the web-search settings toggle (Settings → 联网搜索).
 *
 * server.ts imports interface.html, which tsx can't load — bundle first with
 * the same .html text loader as the production build, then run with node:
 *   npx esbuild scripts/test-webtoggle.ts --bundle --platform=node --format=cjs \
 *     --loader:.html=text --define:__BUILD_ID__='"test"' --define:__APP_VERSION__='"test"' \
 *     --outfile=/tmp/test-webtoggle.cjs && node /tmp/test-webtoggle.cjs
 *
 * Boots the REAL assistant server (same esbuild bundling as production, with a
 * minimal fake Extension context — no Live needed) plus a mock Anthropic API
 * that captures request bodies, then asserts:
 *   1. default (toggle off): the tools list sent to the model has no
 *      web_search/web_fetch, and the system prompt gives the "web is OFF"
 *      instruction;
 *   2. after POST /api/web-config {enabled:true}: web tools appear and the
 *      system prompt gives the "web is ON" instruction;
 *   3. the toggle persists to providers.json (default-off requirement).
 */
import * as http from "node:http";
import * as fs from "node:fs";
import { startServer } from "../src/server.js";

async function main() {

const STORE = "/tmp/aibleton-webtoggle-test";
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });

// ---- mock Anthropic API: capture bodies, reply with plain text ----
const captured: string[] = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    captured.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = (mock.address() as { port: number }).port;

// ---- real server, minimal fake context (only what startServer touches) ----
const ctx = {
  environment: { storageDirectory: STORE },
  application: { song: { tracks: [] } },
  ui: { showModalDialog: async () => ({}) },
} as never;
const { port } = await startServer(ctx);
const base = `http://127.0.0.1:${port}`;

async function chatOnce(): Promise<{ tools: string[]; system: string }> {
  const before = captured.length;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "hi",
      provider: "claude",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: "mock-model",
    }),
  });
  if (res.status !== 202) throw new Error(`/api/chat -> ${res.status}`);
  // The task runs in the background; wait for the mock to be hit.
  for (let i = 0; i < 100 && captured.length === before; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (captured.length === before) throw new Error("mock LLM never received a request");
  const body = JSON.parse(captured[captured.length - 1]) as {
    tools?: { name: string }[];
    system?: string;
  };
  return { tools: (body.tools ?? []).map((t) => t.name), system: body.system ?? "" };
}

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failed = true;
};

// 1. default OFF
let r = await chatOnce();
check(!r.tools.includes("web_search") && !r.tools.includes("web_fetch"), "off: web tools absent from request");
check(r.system.includes("web access is OFF"), "off: system prompt says web is OFF");
check(!r.system.includes("access is ON"), "off: no ON guidance in system prompt");

// 2. turn it on via the API the UI uses
const post = await fetch(`${base}/api/web-config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ enabled: true }),
});
check(post.status === 200, "POST /api/web-config accepted");
const persisted = JSON.parse(fs.readFileSync(`${STORE}/providers.json`, "utf8")) as { web?: { enabled?: boolean } };
check(persisted.web?.enabled === true, "toggle persisted to providers.json");

r = await chatOnce();
check(r.tools.includes("web_search") && r.tools.includes("web_fetch"), "on: web tools present in request");
check(r.system.includes("access is ON"), "on: system prompt says web is ON");

// 3. back off
await fetch(`${base}/api/web-config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ enabled: false }),
});
r = await chatOnce();
check(!r.tools.includes("web_search"), "off again: web tools absent");

mock.close();
process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
