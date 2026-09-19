import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ctx } from "../state.js";
import { listenHintFor } from "./listenhint.js";

/** Minimal Ctx stub: 4/4 song, two tracks (index 0 "Bass", index 1 "Drums"). */
function ctx(overrides?: {
  num?: number;
  den?: number;
  tracks?: { name: string; solo?: boolean; mute?: boolean; clips?: number }[];
}): Ctx {
  const tracks = overrides?.tracks ?? [
    { name: "Bass", clips: 0 },
    { name: "Drums", clips: 0 },
  ];
  return {
    application: {
      song: {
        scenes: [{ signatureNumerator: overrides?.num ?? 4, signatureDenominator: overrides?.den ?? 4 }],
        tracks: tracks.map((t) => ({
          name: t.name,
          solo: t.solo ?? false,
          mute: t.mute ?? false,
          arrangementClips: Array.from({ length: t.clips ?? 0 }, () => ({})),
        })),
      },
    },
  } as unknown as Ctx;
}

describe("listenHintFor", () => {
  it("write_midi_clip: bar range from beats + solo suggestion", () => {
    const h = listenHintFor(ctx(), "write_midi_clip", {}, { track_index: 0, start: 32, length: 16 });
    assert.deepEqual(h, { tracks: ["Bass"], start_bar: 9, end_bar: 12, suggest_solo: "Bass" });
  });

  it("write_midi_clip: single bar omits end_bar", () => {
    const h = listenHintFor(ctx(), "write_midi_clip", {}, { track_index: 0, start: 0, length: 4 });
    assert.deepEqual(h, { tracks: ["Bass"], start_bar: 1, suggest_solo: "Bass" });
  });

  it("respects a non-4/4 signature", () => {
    const h = listenHintFor(
      ctx({ num: 6, den: 8 }),
      "write_midi_clip",
      {},
      { track_index: 0, start: 6, length: 6 },
    );
    assert.deepEqual(h, { tracks: ["Bass"], start_bar: 3, end_bar: 4, suggest_solo: "Bass" });
  });

  it("set_clip_notes: always suggests A/B (overwrote an existing clip)", () => {
    const h = listenHintFor(ctx(), "set_clip_notes", {}, { track_index: 1, start: 16, length: 16 });
    assert.equal(h?.suggest_ab, true);
    assert.equal(h?.start_bar, 5);
  });

  it("no solo suggestion when the track is already solo or muted", () => {
    const soloed = ctx({ tracks: [{ name: "Bass", solo: true }, { name: "Drums" }] });
    assert.equal(listenHintFor(soloed, "set_track_mixer", {}, { track_index: 0 })?.suggest_solo, undefined);
    const muted = ctx({ tracks: [{ name: "Bass", mute: true }, { name: "Drums" }] });
    assert.equal(listenHintFor(muted, "set_track_mixer", {}, { track_index: 0 })?.suggest_solo, undefined);
  });

  it("no solo suggestion for single-track sets or multi-track changes", () => {
    const single = ctx({ tracks: [{ name: "Bass" }] });
    assert.equal(listenHintFor(single, "set_track_mixer", {}, { track_index: 0 })?.suggest_solo, undefined);
    const arranged = listenHintFor(ctx(), "arrange_song", {}, {
      placements: [
        { track: "Bass", start_bar: 9, length_bars: 8 },
        { track: "Drums", start_bar: 1, length_bars: 16 },
      ],
    });
    assert.equal(arranged?.suggest_solo, undefined);
    assert.deepEqual(arranged?.tracks, ["Bass", "Drums"]);
    assert.deepEqual([arranged?.start_bar, arranged?.end_bar], [1, 16]);
  });

  it("arrange_song: cleared range suggests A/B", () => {
    const h = listenHintFor(ctx(), "arrange_song", {}, {
      cleared: { range_bars: [1, 8] },
      placements: [{ track: "Bass", start_bar: 1, length_bars: 8 }],
    });
    assert.equal(h?.suggest_ab, true);
  });

  it("device/param changes: track hint without bars", () => {
    const h = listenHintFor(ctx(), "set_device_parameters", {}, { track_index: 0, device: "Wavetable" });
    assert.deepEqual(h, { tracks: ["Bass"], suggest_solo: "Bass" });
  });

  it("generate_audio: hint only when imported, A/B when the track had prior clips", () => {
    assert.equal(listenHintFor(ctx(), "generate_audio", {}, { file: "/x.wav" }), undefined);
    const fresh = listenHintFor(ctx(), "generate_audio", { importTo: { start_beat: 32 } }, {
      imported: { track: "Bass", track_index: 0 },
    });
    assert.deepEqual(fresh, { tracks: ["Bass"], start_bar: 9, suggest_solo: "Bass" });
    const withPrior = ctx({ tracks: [{ name: "Bass", clips: 2 }, { name: "Drums" }] });
    const h = listenHintFor(withPrior, "generate_audio", { importTo: { start_beat: 32 } }, {
      imported: { track: "Bass", track_index: 0 },
    });
    assert.equal(h?.suggest_ab, true);
  });

  it("session audio imports: no arrangement bar range", () => {
    const imp = listenHintFor(ctx(), "import_audio_clip", { scene_index: 2, start_beat: 32 }, {
      track: "Bass",
      track_index: 0,
    });
    assert.deepEqual(imp, { tracks: ["Bass"], suggest_solo: "Bass" });
    const gen = listenHintFor(ctx(), "generate_audio", { importTo: { scene_index: 2, start_beat: 32 } }, {
      imported: { track: "Bass", track_index: 0, scene_index: 2 },
    });
    assert.deepEqual(gen, { tracks: ["Bass"], suggest_solo: "Bass" });
  });

  it("returns undefined for read-only / silent tools", () => {
    for (const name of ["get_song_overview", "analyze_song", "set_tempo", "rename_track", "set_track_state"]) {
      assert.equal(listenHintFor(ctx(), name, {}, { track_index: 0 }), undefined, name);
    }
  });
});
