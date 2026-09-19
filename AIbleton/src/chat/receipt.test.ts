import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTurnReceipt } from "./receipt.js";

const ok = (tool: string, result: Record<string, unknown> = {}) => ({ tool, input: {}, result });
const failed = (tool: string) => ({ tool, input: {}, result: { error: "nope" } });

test("receipt is absent for reads, declarations, rejected calls and file-only generation", () => {
  assert.equal(buildTurnReceipt([
    ok("analyze_song"),
    ok("set_goal"),
    failed("write_midi_clip"),
    ok("generate_audio", { path: "/tmp/kick.wav" }),
  ]), undefined);
});

test("receipt retains successful Live mutations in first-seen tool order", () => {
  const receipt = buildTurnReceipt([
    ok("write_midi_clip"),
    ok("write_midi_clip"),
    failed("set_tempo"),
    ok("set_device_parameter"),
    ok("move_upload_sample"),
    ok("generate_audio", { imported: { track_index: 1 } }),
  ]);
  assert.deepEqual(receipt?.tools, ["write_midi_clip", "set_device_parameter", "generate_audio"]);
  assert.equal(receipt?.status, "completed");
  assert.equal(receipt?.undo, "live_undo");
});

test("receipt preserves valid unique listening hints and ignores malformed ones", () => {
  const hint = { tracks: ["Bass"], start_bar: 33, end_bar: 41, suggest_ab: true };
  const receipt = buildTurnReceipt([
    ok("write_midi_clip", { listen_hint: hint }),
    ok("set_clip_notes", { listen_hint: hint }),
    ok("set_device_parameter", { listen_hint: { tracks: [] } }),
  ]);
  assert.deepEqual(receipt?.listenHints, [hint]);
});

test("receipt uses only the server-measured goal outcome", () => {
  const passed = buildTurnReceipt([ok("set_tempo")], {
    status: "passed", objective: "Keep it danceable", verification: "tempo = 128 BPM",
  });
  assert.deepEqual(passed, {
    status: "passed",
    objective: "Keep it danceable",
    tools: ["set_tempo"],
    listenHints: [],
    verification: "tempo = 128 BPM",
    undo: "live_undo",
  });
  assert.equal(buildTurnReceipt([ok("set_tempo")], {
    status: "unmet", objective: "More energy",
  })?.status, "unmet");
});
