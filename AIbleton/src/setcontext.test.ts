import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AudioClip, AudioTrack, ClipSlot, MidiClip, MidiTrack, Scene } from "@ableton-extensions/sdk";
import type { Ctx } from "./state.js";
import { clearRightClickFocus, setContextPrompt, setRightClickFocus, updateSetContext } from "./setcontext.js";

/** Minimal Ctx stub: a song with a document handle id, N tracks/scenes, tempo. */
function ctx(handleId: bigint, opts?: { tracks?: number; scenes?: number; tempo?: number }): Ctx {
  return {
    application: {
      song: {
        handle: { id: handleId },
        tempo: opts?.tempo ?? 120,
        tracks: Array.from({ length: opts?.tracks ?? 2 }, () => ({})),
        scenes: Array.from({ length: opts?.scenes ?? 4 }, () => ({})),
      },
    },
  } as unknown as Ctx;
}

function live<T>(prototype: object, fields: Record<string, unknown>): T {
  const object = Object.create(prototype) as T;
  Object.defineProperties(
    object as object,
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, configurable: true }])),
  );
  return object;
}

function midiTrack(id: bigint, name = "Bass"): MidiTrack<"1.0.0"> {
  return live(MidiTrack.prototype, { handle: { id }, name, devices: [], arrangementClips: [], clipSlots: [] });
}

function audioTrack(id: bigint, name = "Vocal"): AudioTrack<"1.0.0"> {
  return live(AudioTrack.prototype, { handle: { id }, name, devices: [], arrangementClips: [], clipSlots: [] });
}

function midiClip(id: bigint): MidiClip<"1.0.0"> {
  return live(MidiClip.prototype, {
    handle: { id }, name: "Bass riff", startTime: 8, duration: 4, notes: [{ pitch: 36 }],
  });
}

function audioClip(id: bigint): AudioClip<"1.0.0"> {
  return live(AudioClip.prototype, {
    handle: { id }, name: "Vocal take", startTime: 12, duration: 8, filePath: "/Samples/Vocal.wav",
  });
}

function scene(id: bigint): Scene<"1.0.0"> {
  return live(Scene.prototype, { handle: { id }, name: "Drop", signatureNumerator: 4, signatureDenominator: 4, tempo: 128 });
}

function clipSlot(id: bigint, clip: MidiClip<"1.0.0">): ClipSlot<"1.0.0"> {
  return live(ClipSlot.prototype, { handle: { id }, clip });
}

/** Creates just enough of Live's object graph for focus resolution. */
function focusCtx(target: object & { handle: { id: bigint } }, setId: bigint): Ctx {
  let tracks: object[] = [];
  let scenes: object[] = [];
  if (target instanceof MidiTrack || target instanceof AudioTrack) {
    tracks = [target];
  } else if (target instanceof Scene) {
    scenes = [target];
  } else {
    const track = target instanceof AudioClip ? audioTrack(90n) : midiTrack(90n);
    if (target instanceof ClipSlot) {
      Object.defineProperty(track, "clipSlots", { value: [target], configurable: true });
    } else {
      Object.defineProperty(track, "arrangementClips", { value: [target], configurable: true });
    }
    tracks = [track];
  }
  return {
    application: { song: { handle: { id: setId }, tempo: 120, tracks, scenes } },
    getObjectFromHandle: (handle: { id: bigint }) => {
      if (handle.id !== target.handle.id) throw new Error("deleted");
      return target;
    },
  } as unknown as Ctx;
}

describe("setcontext", () => {
  it("injects the current-Set summary once a turn ran", () => {
    updateSetContext(ctx(1n, { tracks: 3, scenes: 5, tempo: 124.4 }));
    const prompt = setContextPrompt();
    assert.match(prompt, /Current Live Set: 3 tracks, 5 scenes, 124 BPM/);
    assert.doesNotMatch(prompt, /SET CHANGED/);
  });

  it("warns for one turn when the document handle changes", () => {
    assert.deepEqual(updateSetContext(ctx(1n)), { key: "1", changed: false });
    assert.deepEqual(updateSetContext(ctx(2n)), { key: "2", changed: true });
    assert.match(setContextPrompt(), /SET CHANGED/);
    // Next turn with the same document: warning clears, summary stays.
    updateSetContext(ctx(2n));
    const prompt = setContextPrompt();
    assert.doesNotMatch(prompt, /SET CHANGED/);
    assert.match(prompt, /Current Live Set/);
  });

  it("missing handle is a silent no-op", () => {
    const before = setContextPrompt();
    updateSetContext({ application: { song: { handle: {} } } } as unknown as Ctx);
    assert.equal(setContextPrompt(), before);
  });

  it("renders each supported right-click object as transient prompt context", () => {
    const slotClip = midiClip(14n);
    const cases: Array<{ target: object & { handle: { id: bigint } }; expected: RegExp }> = [
      { target: midiTrack(10n), expected: /MIDI track 0 “Bass”/ },
      { target: audioTrack(11n), expected: /audio track 0 “Vocal”/ },
      { target: scene(12n), expected: /Scene 0 “Drop”, 4\/4, 128 BPM/ },
      { target: clipSlot(13n, slotClip), expected: /ClipSlot on track 0 “Bass”, Session scene 0/ },
      { target: midiClip(15n), expected: /MIDI clip “Bass riff”.*starts at beat 8, lasts 4 beats, 1 notes/ },
      { target: audioClip(16n), expected: /audio clip “Vocal take”.*source Vocal\.wav/ },
    ];

    for (const [index, item] of cases.entries()) {
      clearRightClickFocus();
      const context = focusCtx(item.target, BigInt(100 + index));
      setRightClickFocus(context, item.target.handle);
      updateSetContext(context);
      assert.match(setContextPrompt(), item.expected);
      assert.match(setContextPrompt(), /Treat this as the likely target/);
    }
  });

  it("clears focus when its handle is deleted or its Set changes", () => {
    const target = midiClip(30n);
    const live = focusCtx(target, 200n);
    setRightClickFocus(live, target.handle);
    updateSetContext(live);
    assert.match(setContextPrompt(), /Current right-click focus/);

    const deleted = { ...live, getObjectFromHandle: () => { throw new Error("deleted"); } } as Ctx;
    updateSetContext(deleted);
    assert.doesNotMatch(setContextPrompt(), /Current right-click focus/);

    setRightClickFocus(live, target.handle);
    updateSetContext(live);
    updateSetContext(focusCtx(midiClip(31n), 201n));
    assert.doesNotMatch(setContextPrompt(), /Current right-click focus/);
  });

  it("clears focus for a normal, handle-less open", () => {
    const target = midiTrack(40n);
    const context = focusCtx(target, 300n);
    setRightClickFocus(context, target.handle);
    updateSetContext(context);
    clearRightClickFocus();
    assert.doesNotMatch(setContextPrompt(), /Current right-click focus/);
  });
});
