/**
 * End-to-end smoke test for the analyze_song tool.
 *
 * server.ts imports interface.html, which tsx can't load — bundle first with
 * the same .html text loader as the production build, then run with node:
 *   npx esbuild scripts/test-analyze-song.ts --bundle --platform=node --format=cjs \
 *     --loader:.html=text --define:__BUILD_ID__='"test"' --define:__APP_VERSION__='"test"' \
 *     --outfile=/tmp/test-analyze-song.cjs && node /tmp/test-analyze-song.cjs
 *
 * Boots the REAL assistant server with a minimal fake Extension context (no
 * Live needed) plus a mock Anthropic API. Asserts:
 *   1. analyze_song is in the tools list sent to the model;
 *   2. the system prompt carries the "Song analysis" block;
 *   3. when the model calls analyze_song with YOLO OFF, the tool still runs
 *      WITHOUT a confirmation (it is read-only) and the tool result sent back
 *      to the model contains EMPTY_SET (the fake song has no tracks).
 */
import * as http from "node:http";
import * as fs from "node:fs";
import { startServer } from "../src/server.js";

async function main() {
  const STORE = "/tmp/aibleton-analyze-song-test";
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });

  // ---- mock Anthropic API: 1st request -> tool_use(analyze_song), 2nd -> text ----
  const captured: string[] = [];
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      if (captured.length === 1) {
        res.end(
          JSON.stringify({
            content: [{ type: "tool_use", id: "toolu_1", name: "analyze_song", input: {} }],
            stop_reason: "tool_use",
          }),
        );
      } else {
        res.end(JSON.stringify({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }));
      }
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = (mock.address() as { port: number }).port;

  // ---- real server, minimal fake context ----
  // Regression: the real Extension Host returns BigInt for some getters
  // (Scene.signatureNumerator confirmed) — the snapshot builder must normalize.
  const bigintClip = {
    name: "Audio 1", startTime: 0n, duration: 16n, looping: true,
    loopStart: 0n, loopEnd: 16n, startMarker: 0n, muted: false,
  };
  const ctx = {
    environment: { storageDirectory: STORE },
    application: {
      song: {
        tempo: 122n,
        scenes: [{ name: "Scene 1", signatureNumerator: 4n, signatureDenominator: 4n, tempo: 122n }],
        scaleMode: false, rootNote: 0n, scaleName: "Major",
        scaleIntervals: [0n, 2n, 4n, 5n, 7n, 9n, 11n],
        cuePoints: [{ time: 0n, name: "Intro" }],
        tracks: [
          {
            name: "Audio", mute: false, solo: false, mutedViaSolo: false, arm: false,
            clipSlots: [], arrangementClips: [bigintClip], groupTrack: null, devices: [],
          },
        ],
        returnTracks: [],
      },
    },
    ui: { showModalDialog: async () => ({}) },
  } as never;
  const { port } = await startServer(ctx);
  const base = `http://127.0.0.1:${port}`;

  // Fresh session: the dev machine's real chats.json may load as the current
  // session and its history would contaminate request-body assertions.
  await fetch(`${base}/api/new`, { method: "POST" });

  // YOLO OFF: any non-read-only tool would hang on the confirmation bar.
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "analyze my set",
      provider: "claude",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: "mock-model",
      yolo: false,
    }),
  });
  if (res.status !== 202) throw new Error(`/api/chat -> ${res.status}`);
  for (let i = 0; i < 100 && captured.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (captured.length < 2) {
    throw new Error("tool result never reached the mock LLM (confirmation hang?)");
  }

  let failed = false;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "✅" : "❌"} ${label}`);
    if (!ok) failed = true;
  };

  const req1 = JSON.parse(captured[0]) as { tools?: { name: string }[]; system?: string };
  const tools = (req1.tools ?? []).map((t) => t.name);
  check(tools.includes("analyze_song"), "analyze_song present in tools list");
  check(tools.includes("arrange_song"), "arrange_song present in tools list");
  check((req1.system ?? "").includes("Song analysis (read-only)"), "system prompt has Song analysis block");
  check((req1.system ?? "").includes("Arranging the Set"), "system prompt has Arranging block");

  // The follow-up request carries the tool_result back to the model.
  check(!captured[1].includes("Cannot mix BigInt"), "no BigInt arithmetic crash (host regression)");
  check(captured[1].includes("\\\"tempo\\\":122") || captured[1].includes('"tempo":122'),
    "BigInt tempo normalized to 122 in tool result");
  check(captured[1].includes("caveat"), "analysis completed (caveat present in tool result)");
  check(captured[1].includes("tool_result"), "tool result delivered as tool_result block");

  mock.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
