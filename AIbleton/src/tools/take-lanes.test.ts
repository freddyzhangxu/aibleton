import assert from "node:assert/strict";
import test from "node:test";
import { MidiClip, MidiTrack } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";
import { presentTakeLanes, takeLaneAt } from "./take-lanes.js";

function live<T>(prototype: object, fields: Record<string, unknown>): T {
  const object = Object.create(prototype) as T;
  Object.defineProperties(
    object as object,
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, writable: true, configurable: true }])),
  );
  return object;
}

function fixture() {
  const created: unknown[] = [];
  const clip = live<MidiClip<"1.0.0">>(MidiClip.prototype, {
    name: "", startTime: 8, duration: 4, notes: [],
  });
  const lane = {
    name: "Bass Alternative A",
    clips: [clip],
    async createMidiClip(startTime: number, duration: number) {
      const next = live<MidiClip<"1.0.0">>(MidiClip.prototype, { name: "", startTime, duration, notes: [] });
      created.push(next);
      return next;
    },
  };
  const track = live<MidiTrack<"1.0.0">>(MidiTrack.prototype, {
    name: "Bass", takeLanes: [lane], arrangementClips: [], clipSlots: [], devices: [],
  });
  const context = {
    application: { song: { tracks: [track], scenes: [], returnTracks: [], gridQuantization: 0, gridIsTriplet: false } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, track, lane, created };
}

test("presents Take Lanes compactly and validates lane indices", () => {
  const { track } = fixture();
  assert.deepEqual(presentTakeLanes(track), [{
    index: 0,
    name: "Bass Alternative A",
    clips: [{ index: 0, name: "", type: "MIDI", start_beat: 8, length_beats: 4 }],
  }]);
  assert.throws(() => takeLaneAt(track, 1), /Take Lane 序号 1 无效/);
});

test("writes a non-destructive MIDI candidate into the requested Take Lane", async () => {
  const { context, created } = fixture();
  const out = await runTool(context, "write_take_midi_clip", {
    track_index: 0,
    take_lane_index: 0,
    start_beat: 16,
    length_beats: 8,
    name: "Bass Counterline B",
    notes: [{ pitch: 36, start: 0, duration: 1, velocity: 110 }],
  }) as { take_lane_index: number; clip: string; noteCount: number; start_beat: number };
  assert.equal(created.length, 1);
  const clip = created[0] as MidiClip<"1.0.0">;
  assert.equal(clip.name, "Bass Counterline B");
  assert.deepEqual(clip.notes, [{ pitch: 36, startTime: 0, duration: 1, velocity: 110 }]);
  assert.deepEqual(out, {
    track: "Bass",
    take_lane_index: 0,
    take_lane: "Bass Alternative A",
    clip: "Bass Counterline B",
    start_beat: 16,
    length_beats: 8,
    noteCount: 1,
    swing: 0,
    track_index: 0,
  });
});
