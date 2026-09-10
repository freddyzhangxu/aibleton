import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import {
  appendGeneration,
  GENLOG_MAX_RECORDS,
  genlogPath,
  loadGenLog,
  recordGeneration,
} from "../store.js";
import type { GenerationRecord } from "../types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genlog-test-"));
}

/** Minimal 16-bit PCM mono WAV: 1 s of 440 Hz sine at 8 kHz. */
function sineWav(): Buffer {
  const rate = 8000;
  const n = rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byteRate
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function fakeRecord(id: string): GenerationRecord {
  return {
    id,
    file: `/tmp/${id}.wav`,
    provider: "stable-audio",
    prompt: "p",
    params: { seconds: 8 },
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

test("recordGeneration decodes features and persists the record", () => {
  const dir = tmpDir();
  const file = path.join(dir, "gen-2026-09-10_12-00-00-abcd.wav");
  fs.writeFileSync(file, sineWav());

  const rec = recordGeneration(
    { file, provider: "stable-audio", prompt: "test tone", params: { seconds: 1 } },
    dir,
  );

  assert.equal(rec.id, "gen-2026-09-10_12-00-00-abcd");
  assert.ok(rec.features, "features decoded");
  assert.equal(rec.featuresError, undefined);
  assert.ok(Math.abs(rec.features!.durationSec - 1) < 0.01);

  const loaded = loadGenLog(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, rec.id);
  assert.equal(loaded[0].prompt, "test tone");
  assert.ok(loaded[0].features);
});

test("undecodable files are recorded with featuresError, never thrown", () => {
  const dir = tmpDir();
  const file = path.join(dir, "gen-x.mp3");
  fs.writeFileSync(file, Buffer.from("not real mp3"));

  const rec = recordGeneration({ file, provider: "elevenlabs", prompt: "p", params: { seconds: 8 } }, dir);
  assert.equal(rec.features, undefined);
  assert.match(rec.featuresError!, /unsupported format/);
  assert.equal(loadGenLog(dir).length, 1);
});

test("missing log reads as empty; corrupt log reads as empty", () => {
  const dir = tmpDir();
  assert.deepEqual(loadGenLog(dir), []);
  fs.writeFileSync(genlogPath(dir), "{not json");
  assert.deepEqual(loadGenLog(dir), []);
});

test("append prunes to the FIFO cap", () => {
  const dir = tmpDir();
  for (let i = 0; i < GENLOG_MAX_RECORDS + 5; i++) {
    appendGeneration(fakeRecord(`g${i}`), dir);
  }
  const loaded = loadGenLog(dir);
  assert.equal(loaded.length, GENLOG_MAX_RECORDS);
  assert.equal(loaded[0].id, "g5"); // oldest five dropped
  assert.equal(loaded.at(-1)!.id, `g${GENLOG_MAX_RECORDS + 4}`);
});
