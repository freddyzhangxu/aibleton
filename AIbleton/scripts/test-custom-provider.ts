/**
 * End-to-end test of the custom (OpenAI-compatible) chat provider.
 *
 * server.ts imports interface.html, which tsx can't load — bundle first with
 * the same .html text loader as the production build, then run with node:
 *   npx esbuild scripts/test-custom-provider.ts --bundle --platform=node --format=cjs \
 *     --loader:.html=text --define:__BUILD_ID__='"test"' --define:__APP_VERSION__='"test"' \
 *     --outfile=/tmp/test-custom-provider.cjs && node /tmp/test-custom-provider.cjs
 *
 * Boots the REAL assistant server (fake Extension context — no Live needed)
 * plus a mock OpenAI-compatible endpoint, then asserts:
 *   1. request hits {base}/chat/completions in the right shape: system prompt
 *      as messages[0], chat/completions-style tools, NO `instructions` /
 *      `reasoning` fields (xAI rejects both), Bearer auth;
 *   2. the tool loop completes: mock's tool_call is executed, result comes back
 *      as a role:"tool" message, final text wins;
 *   3. missing baseUrl/model → the multilingual "incomplete" hint, no request;
 *   4. keyless config (Ollama-style) → NO authorization header is sent.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import { startServer } from "../src/server.js";

async function main() {

const STORE = "/tmp/aibleton-custom-test";
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(STORE, { recursive: true });

// ---- mock OpenAI-compatible API: stateless, script depends on the body ----
const captured: { body: string; auth: string | undefined; path: string }[] = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    captured.push({ body, auth: req.headers.authorization, path: req.url ?? "" });
    const parsed = JSON.parse(body) as { messages?: { role: string }[] };
    const hasToolResult = (parsed.messages ?? []).some((m) => m.role === "tool");
    console.log(`   [mock] req #${captured.length}: roles=${(parsed.messages ?? []).map((m) => m.role).join(",")} → ${hasToolResult ? "text" : "tool_call"}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(
      hasToolResult
        ? { choices: [{ message: { content: "完成" } }] }
        : {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: { name: "get_song_overview", arguments: "{}" },
                }],
              },
              finish_reason: "tool_calls",
            }],
          },
    ));
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

// loadStore falls back to the real ~/Library chats.json when the test store is
// empty — start a clean session so real history doesn't leak into requests.
await fetch(`${base}/api/new`, { method: "POST" });

async function chat(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status !== 202) throw new Error(`/api/chat -> ${res.status}`);
}

async function waitIdle(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = (await (await fetch(`${base}/api/status`)).json()) as { busy?: boolean };
    if (!s.busy) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server stayed busy");
}

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failed = true;
};

// 1. full config → request shape + tool loop
await chat({
  text: "hi",
  provider: "custom",
  apiKey: "test-key",
  baseUrl: `http://127.0.0.1:${mockPort}/v1`,
  model: "mock-custom",
});
await waitIdle();
const st1 = (await (await fetch(`${base}/api/status`)).json()) as { error?: string | null };
if (st1.error) console.log(`   [debug] status error after chat 1: ${st1.error}`);
check(captured.length >= 2, `tool loop ran (mock saw ${captured.length} requests)`);

const first = JSON.parse(captured[0]?.body ?? "{}") as {
  model?: string;
  instructions?: string;
  reasoning?: unknown;
  messages?: { role: string; content?: unknown }[];
  tools?: { type?: string; function?: { name?: string; parameters?: unknown } }[];
};
check(captured[0]?.path === "/v1/chat/completions", `path is /v1/chat/completions (got ${captured[0]?.path})`);
check(captured[0]?.auth === "Bearer test-key", "Bearer key sent");
check(first.model === "mock-custom", "model passed through");
check(first.messages?.[0]?.role === "system", "system prompt is messages[0]");
check(!("instructions" in first), "no `instructions` field (xAI rejects it)");
check(!("reasoning" in first), "no `reasoning` field (xAI rejects it)");
check(
  (first.tools ?? []).length > 0 &&
    first.tools![0].type === "function" &&
    typeof first.tools![0].function?.name === "string" &&
    typeof first.tools![0].function?.parameters === "object",
  "tools in chat/completions function shape",
);

const second = JSON.parse(captured[1]?.body ?? "{}") as {
  messages?: {
    role: string;
    tool_call_id?: string;
    tool_calls?: { id?: string; function?: { name?: string } }[];
  }[];
};
const roles = (second.messages ?? []).map((m) => m.role);
const assistantIdx = roles.findIndex((r, i) => i > 0 && r === "assistant" && second.messages![i].tool_calls?.length);
check(
  assistantIdx > 0 && second.messages![assistantIdx + 1]?.role === "tool" &&
    second.messages![assistantIdx + 1]?.tool_call_id === "call_1",
  "assistant tool_calls echoed, role:tool result follows with matching id",
);
check(second.messages!.some((m) => m.role === "tool" && m.tool_call_id === "call_1"),
  "tool result fed back under call_1");

// 2. missing baseUrl → hint, and the mock is NOT hit
const before2 = captured.length;
await chat({ text: "no url", provider: "custom", model: "mock-custom" });
await waitIdle();
const st = (await (await fetch(`${base}/api/status`)).json()) as { error?: string | null };
check(captured.length === before2, "missing baseUrl: endpoint never called");
check(/Base URL|API 地址/.test(st.error ?? ""), `hint shown (got: ${st.error})`);

// 3. keyless local server (Ollama-style) → no authorization header
await chat({
  text: "local",
  provider: "custom",
  baseUrl: `http://127.0.0.1:${mockPort}/v1`,
  model: "mock-custom",
});
await waitIdle();
const last = captured[captured.length - 1];
check(last && last.auth === undefined, `no authorization header when key empty (got: ${last?.auth})`);

mock.close();
process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
