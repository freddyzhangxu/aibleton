import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioClip, AudioTrack, MidiTrack } from "@ableton-extensions/sdk";
import { pcmOfSegments, wavOf } from "../music/reference/__tests__/fixtures.js";
import type { Ctx } from "../state.js";
import { analyzeVocalPair } from "./vocal-pair.js";

const temp = mkdtempSync(join(tmpdir(), "aibleton-vocal-pair-"));
after(() => rmSync(temp, { recursive: true, force: true }));

function audioFile(name: string, amplitude: number): string {
  const file = join(temp, name);
  writeFileSync(file, wavOf(pcmOfSegments([[amplitude, 0.5]])));
  return file;
}

function audioClip(filePath: string, name = "Vocal"): AudioClip<"1.0.0"> {
  const clip = Object.create(AudioClip.prototype) as AudioClip<"1.0.0">;
  Object.defineProperties(clip, {
    name: { value: name },
    filePath: { value: filePath },
    muted: { value: false },
    startTime: { value: 0 },
    endTime: { value: 4 },
  });
  return clip;
}

function track(name: string, files: string[], midi = false): AudioTrack<"1.0.0"> | MidiTrack<"1.0.0"> {
  const object = Object.create(midi ? MidiTrack.prototype : AudioTrack.prototype);
  Object.defineProperties(object, {
    name: { value: name },
    arrangementClips: { value: files.map((file, i) => audioClip(file, `${name} ${i + 1}`)) },
    clipSlots: { value: [] },
    devices: { value: [] },
  });
  return object;
}

function context(tracks: Array<AudioTrack<"1.0.0"> | MidiTrack<"1.0.0">>): Ctx {
  return { application: { song: { tracks, scenes: [] } } } as unknown as Ctx;
}

test("requires one reference source", async () => {
  const recorded = audioFile("recorded.wav", 0.1);
  const ctx = context([track("Lead", [recorded])]);
  await assert.rejects(() => analyzeVocalPair(ctx, { recorded_track_index: 0 }), /reference.*track.*or.*path/i);
  await assert.rejects(() => analyzeVocalPair(ctx, {
    recorded_track_index: 0, reference_track_index: 0, reference_path: recorded,
  }), /exactly one reference/i);
});

test("requires a clip index when a track has multiple arrangement audio clips", async () => {
  const recorded = audioFile("multi.wav", 0.1);
  const reference = audioFile("multi-ref.wav", 0.2);
  const ctx = context([track("Lead", [recorded, recorded])]);
  await assert.rejects(() => analyzeVocalPair(ctx, {
    recorded_track_index: 0, reference_path: reference,
  }), /recorded_clip_index/i);
});

test("rejects MIDI input and the same track as its own reference", async () => {
  const recorded = audioFile("type.wav", 0.1);
  const ctx = context([track("MIDI", [recorded], true), track("Lead", [recorded])]);
  await assert.rejects(() => analyzeVocalPair(ctx, {
    recorded_track_index: 0, reference_track_index: 1,
  }), /Audio Track/i);
  await assert.rejects(() => analyzeVocalPair(ctx, {
    recorded_track_index: 1, reference_track_index: 1,
  }), /different tracks or files/i);
});

test("compares two selected Live vocal clips without changing either track", async () => {
  const recorded = audioFile("take.wav", 0.1);
  const reference = audioFile("stem.wav", 0.2);
  const tracks = [track("Lead", [recorded]), track("Original Vocals", [reference])];
  const out = await analyzeVocalPair(context(tracks), {
    recorded_track_index: 0, recorded_track_name: "Lead",
    reference_track_index: 1, reference_track_name: "Original Vocals",
  });
  assert.equal(out.comparison, "source_file");
  assert.equal(out.recorded.status, "ok");
  assert.equal(out.reference.status, "ok");
  assert.equal(out.recorded.track, "Lead");
  assert.equal(out.reference.track, "Original Vocals");
  assert.ok(out.measurements?.deltas.some((d) => d.metric === "rms" && d.delta < 0));
  assert.equal(tracks[0].arrangementClips.length, 1);
  assert.equal(tracks[1].arrangementClips.length, 1);
});

test("labels unreadable, unsupported, and silent reference audio separately", async () => {
  const recorded = audioFile("valid.wav", 0.1);
  const silent = audioFile("silent.wav", 0);
  const unsupported = join(temp, "bad.txt");
  writeFileSync(unsupported, "not audio");
  const ctx = context([track("Lead", [recorded])]);
  for (const [path, status] of [
    [join(temp, "missing.wav"), "unreadable"],
    [unsupported, "unsupported"],
    [silent, "silent"],
  ] as const) {
    const out = await analyzeVocalPair(ctx, { recorded_track_index: 0, reference_path: path });
    assert.equal(out.recorded.status, "ok");
    assert.equal(out.reference.status, status);
    assert.equal(out.measurements, undefined);
  }
});
