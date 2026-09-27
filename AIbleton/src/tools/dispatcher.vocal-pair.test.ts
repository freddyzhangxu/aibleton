import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioClip, AudioTrack } from "@ableton-extensions/sdk";
import { READ_ONLY_TOOLS } from "../chat/gates.js";
import { pcmOfSegments, wavOf } from "../music/reference/__tests__/fixtures.js";
import type { Ctx } from "../state.js";
import { TOOLS } from "./definitions.js";
import { runTool } from "./dispatcher.js";

const temp = mkdtempSync(join(tmpdir(), "aibleton-vocal-dispatch-"));
after(() => rmSync(temp, { recursive: true, force: true }));

function wav(name: string, amp: number): string {
  const file = join(temp, name);
  writeFileSync(file, wavOf(pcmOfSegments([[amp, 0.5]])));
  return file;
}

function comparisonContext(filePath: string): { context: Ctx; transactions: string[] } {
  const clip = Object.create(AudioClip.prototype) as AudioClip<"1.0.0">;
  Object.defineProperties(clip, {
    name: { value: "Take" }, filePath: { value: filePath }, muted: { value: false },
  });
  const track = Object.create(AudioTrack.prototype) as AudioTrack<"1.0.0">;
  Object.defineProperties(track, {
    name: { value: "Lead" }, arrangementClips: { value: [clip] }, clipSlots: { value: [] }, devices: { value: [] },
  });
  const transactions: string[] = [];
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => { transactions.push("transaction"); return fn(); },
  } as unknown as Ctx;
  return { context, transactions };
}

test("exposes vocal-pair analysis in the model tool catalog", () => {
  const tool = TOOLS.find((item) => item.name === "analyze_vocal_pair");
  assert.ok(tool);
  assert.deepEqual(tool.input_schema.required, ["recorded_track_index"]);
  assert.ok("reference_path" in tool.input_schema.properties);
  assert.ok("reference_track_index" in tool.input_schema.properties);
  assert.ok(READ_ONLY_TOOLS.has("analyze_vocal_pair"), "analysis must not ask for Set-mutation confirmation");
});

test("dispatches local pair analysis without opening a Live transaction", async () => {
  const recorded = wav("recorded.wav", 0.1);
  const reference = wav("reference.wav", 0.2);
  const { context, transactions } = comparisonContext(recorded);
  const result = await runTool(context, "analyze_vocal_pair", {
    recorded_track_index: 0, recorded_track_name: "Lead", reference_path: reference,
  }) as { comparison: string; measurements?: { deltas: { metric: string }[] } };
  assert.equal(result.comparison, "source_file");
  assert.ok(result.measurements?.deltas.some((delta) => delta.metric === "rms"));
  assert.deepEqual(transactions, []);
});

test("rejects both reference alternatives before changing the Set", async () => {
  const recorded = wav("both.wav", 0.1);
  const { context, transactions } = comparisonContext(recorded);
  await assert.rejects(() => runTool(context, "analyze_vocal_pair", {
    recorded_track_index: 0, reference_track_index: 0, reference_path: join(temp, "reference.wav"),
  }), /exactly one reference/i);
  assert.deepEqual(transactions, []);
});
