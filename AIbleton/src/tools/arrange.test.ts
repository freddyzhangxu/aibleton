import assert from "node:assert/strict";
import { test } from "node:test";
import { MidiClip, MidiTrack } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { arrangeSong } from "./arrange.js";

type ArrangeMock = {
  context: Ctx;
  calls: string[];
};

function sourceClip(): MidiClip<"1.0.0"> {
  const clip = Object.create(MidiClip.prototype) as MidiClip<"1.0.0">;
  Object.defineProperties(clip, {
    name: { value: "Source", configurable: true },
    startTime: { value: 0, configurable: true },
    endTime: { value: 4, configurable: true },
    duration: { value: 4, configurable: true },
    looping: { value: false, configurable: true },
    loopStart: { value: 0, configurable: true },
    loopEnd: { value: 4, configurable: true },
    startMarker: { value: 0, configurable: true },
    color: { value: 0, configurable: true },
    muted: { value: false, configurable: true },
    notes: {
      value: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }],
      configurable: true,
    },
  });
  return clip;
}

function createdClip(calls: string[], start: number): MidiClip<"1.0.0"> {
  const clip = Object.create(MidiClip.prototype) as MidiClip<"1.0.0">;
  Object.defineProperties(clip, {
    notes: { set: () => calls.push(`notes:${start}`), configurable: true },
    name: { set: () => calls.push(`name:${start}`), configurable: true },
    color: { set: () => calls.push(`color:${start}`), configurable: true },
    muted: { set: () => calls.push(`muted:${start}`), configurable: true },
  });
  return clip;
}

function arrangeMock(failCreateAt?: number): ArrangeMock {
  const calls: string[] = [];
  const source = sourceClip();
  let creates = 0;
  const track = Object.create(MidiTrack.prototype) as MidiTrack<"1.0.0">;
  Object.defineProperties(track, {
    name: { value: "Piano", configurable: true },
    arrangementClips: { value: [source], configurable: true },
    clipSlots: { value: [], configurable: true },
    clearClipsInRange: {
      value: async (start: number, end: number) => calls.push(`clear:${start}-${end}`),
      configurable: true,
    },
    createMidiClip: {
      value: async (start: number) => {
        creates++;
        calls.push(`create:${start}`);
        if (creates === failCreateAt) throw new Error("create failed");
        return createdClip(calls, start);
      },
      configurable: true,
    },
  });

  return {
    calls,
    context: {
      application: { song: { scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }], tracks: [track] } },
      withinTransaction: () => {
        throw new Error("arrangeSong must not call context.withinTransaction");
      },
    } as unknown as Ctx,
  };
}

test("arrangeSong clears before creating clips without an async outer transaction", async () => {
  const { context, calls } = arrangeMock();
  const result = await arrangeSong(context, {
    clear_range_bars: [1, 1],
    placements: [{ track_index: 0, clip_index: 0, start_bar: 1, length_bars: 1, name: "Copy" }],
  }) as { undo: string };

  assert.deepEqual(calls, ["clear:0-4", "create:0", "notes:0", "name:0"]);
  assert.match(result.undo, /逐步回退/);
});

test("arrangeSong preserves earlier mutations when a later placement fails", async () => {
  const { context, calls } = arrangeMock(2);

  await assert.rejects(
    arrangeSong(context, {
      clear_range_bars: [1, 2],
      placements: [
        { track_index: 0, clip_index: 0, start_bar: 1, length_bars: 1, name: "First" },
        { track_index: 0, clip_index: 0, start_bar: 2, length_bars: 1, name: "Second" },
      ],
    }),
    /create failed/,
  );

  assert.deepEqual(calls, ["clear:0-8", "create:0", "notes:0", "name:0", "create:4"]);
});
