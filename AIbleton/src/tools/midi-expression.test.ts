import assert from "node:assert/strict";
import test from "node:test";
import { MidiClip } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";
import { applySwing, parseNotes, snapNotesToGrid } from "./helpers.js";

test("parseNotes maps explicit expression fields to Live's NoteDescription shape", () => {
  assert.deepEqual(parseNotes([{
    pitch: 38, start: 0.25, duration: 0.5, velocity: 84,
    probability: 0.35, velocity_deviation: -9, release_velocity: 47, muted: true,
  }], 4), [{
    pitch: 38, startTime: 0.25, duration: 0.5, velocity: 84,
    probability: 0.35, velocityDeviation: -9, releaseVelocity: 47, muted: true,
  }]);
  // Legacy note input keeps the exact old payload shape.
  assert.deepEqual(parseNotes([{ pitch: 36, start: 0 }], 4), [{
    pitch: 36, startTime: 0, duration: 0.25, velocity: 100,
  }]);
});

test("parseNotes validates every expression boundary", () => {
  const base = { pitch: 60, start: 0 };
  assert.doesNotThrow(() => parseNotes([{ ...base, probability: 0, velocity_deviation: -127, release_velocity: 0 }], 4));
  assert.doesNotThrow(() => parseNotes([{ ...base, probability: 1, velocity_deviation: 127, release_velocity: 127 }], 4));
  assert.throws(() => parseNotes([{ ...base, probability: 1.01 }], 4), /probability/);
  assert.throws(() => parseNotes([{ ...base, velocity_deviation: -128 }], 4), /velocity_deviation/);
  assert.throws(() => parseNotes([{ ...base, release_velocity: 128 }], 4), /release_velocity/);
  assert.throws(() => parseNotes([{ ...base, muted: "yes" }], 4), /muted/);
});

test("grid snap and swing preserve expression values", () => {
  const input = parseNotes([{
    pitch: 42, start: 0.24, velocity: 100, probability: 0.5,
    velocity_deviation: 7, release_velocity: 32, muted: false,
  }], 4);
  const snapped = snapNotesToGrid(input, 8, false); // 1/16 = 0.25 beat
  const swung = applySwing(snapped, 60);
  assert.equal(swung[0].startTime, 0.3);
  assert.equal(swung[0].velocity, 85);
  assert.equal(swung[0].probability, 0.5);
  assert.equal(swung[0].velocityDeviation, 7);
  assert.equal(swung[0].releaseVelocity, 32);
  assert.equal(swung[0].muted, false);
});

test("get_clip_notes round-trips expression fields with tool-facing names", async () => {
  const clip = Object.create(MidiClip.prototype) as MidiClip<"1.0.0">;
  Object.defineProperties(clip, {
    name: { value: "Ghost hats", configurable: true },
    startTime: { value: 8, configurable: true },
    duration: { value: 4, configurable: true },
    notes: { value: [{ pitch: 42, startTime: 0.25, duration: 0.25, velocity: 70, probability: 0.4, velocityDeviation: -3, releaseVelocity: 55, muted: false }], configurable: true },
  });
  const context = {
    application: { song: { tracks: [{ name: "Hats", arrangementClips: [clip], clipSlots: [], takeLanes: [] }], scenes: [] } },
  } as unknown as Ctx;
  const out = await runTool(context, "get_clip_notes", { track_index: 0, clip_index: 0 }) as { notes: unknown[] };
  assert.deepEqual(out.notes, [{
    pitch: 42, start: 0.25, duration: 0.25, velocity: 70,
    probability: 0.4, velocity_deviation: -3, release_velocity: 55, muted: false,
  }]);
});
