import assert from "node:assert/strict";
import test from "node:test";
import { AudioTrack, MidiTrack } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

type FakeClip = { name: string; notes?: unknown[]; duration?: number };

function midiTrack(name: string, sceneCount = 1): MidiTrack<"1.0.0"> {
  const arrangementClips: FakeClip[] = [];
  const clipSlots = Array.from({ length: sceneCount }, () => ({ clip: null as FakeClip | null }));
  const track = Object.create(MidiTrack.prototype) as MidiTrack<"1.0.0"> & {
    createMidiClip: (start: number, duration: number) => Promise<FakeClip>;
  };
  Object.defineProperties(track, {
    name: { value: name, writable: true, configurable: true },
    arrangementClips: { value: arrangementClips, configurable: true },
    clipSlots: { value: clipSlots, configurable: true },
    devices: { value: [], configurable: true },
    takeLanes: { value: [], configurable: true },
  });
  track.createMidiClip = (async (_start: number, duration: number) => {
    const clip: FakeClip = { name: "MIDI Clip", duration, notes: [] };
    arrangementClips.push(clip);
    return clip;
  }) as unknown as typeof track.createMidiClip;
  for (const slot of clipSlots) {
    (slot as typeof slot & { createMidiClip: (duration: number) => Promise<FakeClip> }).createMidiClip = async (duration) => {
      const clip: FakeClip = { name: "Session MIDI Clip", duration, notes: [] };
      slot.clip = clip;
      return clip;
    };
  }
  return track;
}

function audioTrack(name: string, sceneCount = 1, sessionClip: FakeClip | null = null): AudioTrack<"1.0.0"> {
  const track = Object.create(AudioTrack.prototype) as AudioTrack<"1.0.0">;
  Object.defineProperties(track, {
    name: { value: name, writable: true, configurable: true },
    arrangementClips: { value: [{ name: "Existing audio" }], configurable: true },
    clipSlots: {
      value: Array.from({ length: sceneCount }, (_, index) => ({ clip: index === 0 ? sessionClip : null })),
      configurable: true,
    },
    devices: { value: [{ name: "Simpler" }], configurable: true },
    takeLanes: { value: [], configurable: true },
  });
  return track;
}

function contextWithTracks(tracks: Array<MidiTrack<"1.0.0"> | AudioTrack<"1.0.0">>, sceneCount = 1): Ctx {
  const song = {
    tracks,
    scenes: Array.from({ length: sceneCount }, () => ({ name: "Scene" })),
    returnTracks: [],
    gridQuantization: 0,
    gridIsTriplet: false,
    createMidiTrack: async () => {
      const created = midiTrack("New MIDI", sceneCount);
      tracks.push(created);
      return created;
    },
  };
  return {
    application: { song },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
}

test("write_midi_clip auto-creates a MIDI track for an Audio Track", async () => {
  const audio = audioTrack("Audio 3");
  const tracks = [midiTrack("Drums"), midiTrack("Bass"), audio, audioTrack("Audio 4")];
  const context = contextWithTracks(tracks);

  const result = await runTool(context, "write_midi_clip", {
    track_index: 2,
    track_name: "Audio 3",
    notes: [{ pitch: 60, start: 0, duration: 1 }],
  }) as Record<string, unknown>;

  assert.equal(result.track_index, 4);
  assert.equal(result.track, "MIDI - Audio 3");
  assert.equal(result.auto_created_midi_track, true);
  assert.equal(result.source_audio_track, "Audio 3");
  assert.equal(result.source_audio_track_index, 2);
  assert.equal(result.created_position_relative_to_source, "after");
  assert.equal(audio.arrangementClips.length, 1);
  assert.equal((tracks[4].arrangementClips[0] as FakeClip).notes?.length, 1);
});

test("auto-created MIDI track names avoid collisions", async () => {
  const audio = audioTrack("Audio 3");
  const tracks = [audioTrack("MIDI - Audio 3"), audio];
  const context = contextWithTracks(tracks);

  const result = await runTool(context, "write_midi_clip", {
    track_index: 1,
    track_name: "Audio 3",
    notes: [],
  }) as Record<string, unknown>;

  assert.equal(result.track, "MIDI - Audio 3 2");
});

test("write_session_clip auto-creates a MIDI track without touching the Audio slot", async () => {
  const existingAudioClip = { name: "Existing audio clip" };
  const audio = audioTrack("Vocal", 1, existingAudioClip);
  const tracks = [audio];
  const context = contextWithTracks(tracks);

  const result = await runTool(context, "write_session_clip", {
    track_index: 0,
    track_name: "Vocal",
    scene_index: 0,
    notes: [{ pitch: 64, start: 0, duration: 0.5 }],
  }) as Record<string, unknown>;

  assert.equal(result.track_index, 1);
  assert.equal(result.auto_created_midi_track, true);
  assert.equal(audio.clipSlots[0].clip, existingAudioClip);
  assert.equal((tracks[1].clipSlots[0].clip as FakeClip).notes?.length, 1);
});

test("existing MIDI track writes keep the normal result shape", async () => {
  const track = midiTrack("Lead");
  const context = contextWithTracks([track]);

  const result = await runTool(context, "write_midi_clip", {
    track_index: 0,
    track_name: "Lead",
    notes: [],
  }) as Record<string, unknown>;

  assert.equal(result.track_index, 0);
  assert.equal(result.auto_created_midi_track, undefined);
  assert.equal(track.arrangementClips.length, 1);
});
