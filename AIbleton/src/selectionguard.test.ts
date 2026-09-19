import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ctx } from "./state.js";
import { selectionGuard } from "./selectionguard.js";
import type { ResolvedSelection } from "./setcontext.js";

const context = {
  application: {
    song: {
      scenes: [{ signatureNumerator: 4, signatureDenominator: 4 }],
      tracks: [
        { name: "Bass", arrangementClips: [] },
        { name: "Drums", arrangementClips: [] },
      ],
    },
  },
} as unknown as Ctx;

describe("selectionGuard", () => {
  const arrangement: ResolvedSelection = {
    kind: "arrangement",
    tracks: [{ index: 0, name: "Bass" }],
    startBeat: 8,
    endBeat: 16,
  };

  it("allows a selected Arrangement track and range", () => {
    assert.equal(selectionGuard(context, arrangement, false, "write_midi_clip", {
      track_index: 0, start_beat: 8, length_beats: 8,
    }), null);
  });

  it("refuses Arrangement track and timeline escapes before dispatch", () => {
    assert.match(selectionGuard(context, arrangement, false, "set_track_state", { index: 1, mute: true }) ?? "", /目标轨道 1/);
    assert.match(selectionGuard(context, arrangement, false, "write_midi_clip", {
      track_index: 0, start_beat: 12, length_beats: 8,
    }) ?? "", /目标时间范围/);
    assert.match(selectionGuard(context, arrangement, false, "arrange_song", {
      placements: [{ track_index: 0, start_bar: 5, length_bars: 1, clip_index: 0 }],
    }) ?? "", /placement 的时间范围/);
  });

  it("permits an explicit whole-song request for this turn", () => {
    assert.equal(selectionGuard(context, arrangement, true, "write_midi_clip", {
      track_index: 1, start_beat: 32, length_beats: 4,
    }), null);
  });

  it("requires the exact selected Session slot", () => {
    const session: ResolvedSelection = {
      kind: "session",
      slots: [{ trackIndex: 1, trackName: "Drums", sceneIndex: 2 }],
    };
    assert.equal(selectionGuard(context, session, false, "write_session_clip", {
      track_index: 1, scene_index: 2, length_beats: 4,
    }), null);
    assert.match(selectionGuard(context, session, false, "write_session_clip", {
      track_index: 1, scene_index: 1, length_beats: 4,
    }) ?? "", /目标 Session 槽/);
  });

  it("applies the Arrangement range boundary to Take Lane candidates", () => {
    assert.equal(selectionGuard(context, arrangement, false, "write_take_midi_clip", {
      track_index: 0, take_lane_index: 0, start_beat: 8, length_beats: 8,
    }), null);
    assert.match(selectionGuard(context, arrangement, false, "import_take_audio_clip", {
      track_index: 0, take_lane_index: 0, start_beat: 14, duration_beats: 4,
    }) ?? "", /目标时间范围/);
  });

  it("keeps Warp edits inside the selected Arrangement clip", () => {
    assert.match(selectionGuard(context, arrangement, false, "set_audio_clip_warp", {
      track_index: 1, clip_index: 0, warped: true,
    }) ?? "", /目标轨道 1/);
  });

  it("keeps Drum Rack pad-device deletion inside the selected track", () => {
    assert.equal(selectionGuard(context, arrangement, false, "delete_drum_pad_device", {
      track_index: 0, pad_note: 36, device_index: 1,
    }), null);
    assert.match(selectionGuard(context, arrangement, false, "delete_drum_pad_device", {
      track_index: 1, pad_note: 36, device_index: 1,
    }) ?? "", /目标轨道 1/);
  });

  it("keeps Drum Rack pad sample replacement inside the selected track", () => {
    assert.equal(selectionGuard(context, arrangement, false, "replace_drum_pad_sample", {
      track_index: 0, pad_note: 36, file_path: "/tmp/kick.wav",
    }), null);
    assert.match(selectionGuard(context, arrangement, false, "replace_drum_pad_sample", {
      track_index: 1, pad_note: 36, file_path: "/tmp/kick.wav",
    }) ?? "", /目标轨道 1/);
  });

  it("keeps Drum Rack pad device parameter writes inside the selected track", () => {
    assert.equal(selectionGuard(context, arrangement, false, "set_drum_pad_device_parameter", {
      track_index: 0, pad_note: 36, device_index: 0, parameter: "dry/wet", value: "0.5",
    }), null);
    assert.match(selectionGuard(context, arrangement, false, "set_drum_pad_device_parameters", {
      track_index: 1, pad_note: 36, device_index: 0, params: [],
    }) ?? "", /目标轨道 1/);
  });
});
