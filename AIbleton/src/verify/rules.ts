/**
 * verify/rules.ts — the per-tool postcondition table.
 *
 * Each rule turns a mutating tool call (input + reported result) into
 * deterministic CheckSpecs. v1 covers three categories:
 * - track mixer/state: set_track_mixer, set_track_state, rename_track, set_tempo
 * - devices:           insert_device, set_device_parameter
 * - clips:             write_midi_clip, write_session_clip, set_clip_notes
 * - plus track creation (create_midi_track / create_audio_track).
 *
 * Composite goal-level verification (arrange_song) is intentionally out of
 * scope — single actions only.
 */

import { toNum } from "./verifier.js";
import type { CheckSpec, PostconditionRule, ProbeSong, ProbeTrack } from "./types.js";

const EPS = 1e-3;
const approx = (a: number, b: number, eps = EPS): boolean => Math.abs(a - b) <= eps;
const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Track lookup shared by all track-scoped probes. The fresh index rides the
 * tool result (trackResult) — name re-resolution already happened there. */
function trackAt(song: ProbeSong, index: number): ProbeTrack | undefined {
  return song.tracks[index];
}

const noTrack = (index: number) => ({ passed: false, actual: `轨道 ${index} 已不存在` });

// ---------------------------------------------------------------------------
// Tempo / track state
// ---------------------------------------------------------------------------

const setTempo: PostconditionRule = (input) => {
  const want = Number(input.bpm);
  return [
    {
      id: "tempo",
      expected: `${fmt(want)} BPM`,
      probe: (song) => {
        const actual = toNum(song.tempo);
        return { passed: approx(actual, want, 0.01), actual: `${fmt(actual)} BPM` };
      },
    },
  ];
};

const setTrackMixer: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  const specs: CheckSpec[] = [];
  for (const [key, label] of [
    ["volume", "音量"],
    ["pan", "声像"],
  ] as const) {
    if (typeof result[key] === "undefined") continue;
    const want = Number(result[key]); // the clamped value the tool wrote
    specs.push({
      id: `track[${ti}].${key}`,
      expected: `${label} ${fmt(want)}`,
      probe: async (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        const actual = toNum(await (key === "volume" ? t.mixer.volume : t.mixer.panning).getValue());
        return { passed: approx(actual, want), actual: fmt(actual) };
      },
    });
  }
  return specs;
};

const setTrackState: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  return (["mute", "solo", "arm"] as const)
    .filter((k) => typeof input[k] === "boolean")
    .map((k) => ({
      id: `track[${ti}].${k}`,
      expected: `${k}=${input[k]}`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        return { passed: t[k] === input[k], actual: `${k}=${t[k]}` };
      },
    }));
};

const renameTrack: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  const want = String(input.name);
  return [
    {
      id: `track[${ti}].name`,
      expected: `「${want}」`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        return { passed: t.name === want, actual: `「${t.name}」` };
      },
    },
  ];
};

const createTrack: PostconditionRule = (_input, result) => {
  const want = String(result.created);
  return [
    {
      id: "track.exists",
      expected: `轨道「${want}」存在`,
      probe: (song) => {
        const found = song.tracks.some((t) => t.name === want);
        return {
          passed: found,
          actual: found ? "已创建" : `现有轨道: ${song.tracks.map((t) => t.name).join(", ") || "(空)"}`,
        };
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const insertDevice: PostconditionRule = (_input, result) => {
  const ti = Number(result.track_index);
  const want = String(result.inserted); // the name Live actually gave it
  return [
    {
      id: `track[${ti}].device`,
      expected: `存在设备「${want}」`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        const names = t.devices.map((d) => d.name);
        return { passed: names.includes(want), actual: names.join(", ") || "(无设备)" };
      },
    },
  ];
};

const setDeviceParameter: PostconditionRule = (_input, result) => {
  const ti = Number(result.track_index);
  const deviceName = String(result.device);
  const paramName = String(result.parameter);
  // The tool's display value defines the check: number = plain value compare,
  // string = quantized item name compare (it already resolved text -> index).
  const expectNumeric = typeof result.value === "number";
  return [
    {
      id: `track[${ti}].${deviceName}.${paramName}`,
      expected: `${paramName}=${String(result.value)}`,
      probe: async (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        // Two same-named devices on one track can't be told apart here — the
        // first exact-name match wins (v1 limitation, matches result.device).
        const dev = t.devices.find((d) => d.name === deviceName);
        if (!dev) return { passed: false, actual: `设备「${deviceName}」不存在` };
        const p = dev.parameters.find((pp) => pp.name === paramName);
        if (!p) return { passed: false, actual: `参数「${paramName}」不存在` };
        const raw = toNum(await p.getValue());
        if (expectNumeric) {
          return { passed: approx(raw, Number(result.value)), actual: fmt(raw) };
        }
        const itemName = p.valueItems?.[Math.round(raw)]?.name;
        const actual = itemName ?? fmt(raw);
        return {
          passed: actual.toLowerCase() === String(result.value).trim().toLowerCase(),
          actual,
        };
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

const writeMidiClip: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  const start = Number(input.start_beat ?? 0);
  const length = Number(input.length_beats ?? 16);
  const noteCount = Number(result.noteCount); // notes the tool says it wrote
  return [
    {
      id: `track[${ti}].clip@${fmt(start)}`,
      expected: `clip 长度 ${fmt(length)} beats、${noteCount} 个音符`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        const clip = t.arrangementClips.find((c) => approx(toNum(c.startTime), start, 0.01));
        if (!clip) return { passed: false, actual: `起始 ${fmt(start)} 处没有 clip` };
        const bad: string[] = [];
        if (!approx(toNum(clip.duration), length, 0.01)) bad.push(`长度=${fmt(toNum(clip.duration))}`);
        const n = clip.notes?.length ?? 0;
        if (n !== noteCount) bad.push(`音符数=${n}`);
        return { passed: bad.length === 0, actual: bad.join("，") || "符合预期" };
      },
    },
  ];
};

const writeSessionClip: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  const scene = Number(input.scene_index);
  const length = Number(input.length_beats ?? 16);
  const noteCount = Number(result.noteCount);
  return [
    {
      id: `track[${ti}].session[${scene}]`,
      expected: `clip 长度 ${fmt(length)} beats、${noteCount} 个音符`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        const clip = t.clipSlots[scene]?.clip;
        if (!clip) return { passed: false, actual: `场景 ${scene} 槽位为空` };
        const bad: string[] = [];
        if (!approx(toNum(clip.duration), length, 0.01)) bad.push(`长度=${fmt(toNum(clip.duration))}`);
        const n = clip.notes?.length ?? 0;
        if (n !== noteCount) bad.push(`音符数=${n}`);
        return { passed: bad.length === 0, actual: bad.join("，") || "符合预期" };
      },
    },
  ];
};

const setClipNotes: PostconditionRule = (input, result) => {
  const ti = Number(result.track_index);
  const ci = Number(input.clip_index);
  const noteCount = Number(result.noteCount);
  return [
    {
      id: `track[${ti}].clip[${ci}].notes`,
      expected: `${noteCount} 个音符`,
      probe: (song) => {
        const t = trackAt(song, ti);
        if (!t) return noTrack(ti);
        const clip = t.arrangementClips[ci];
        if (!clip) return { passed: false, actual: `clip ${ci} 不存在` };
        const n = clip.notes?.length ?? 0;
        return { passed: n === noteCount, actual: `${n} 个音符` };
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Table + entry point
// ---------------------------------------------------------------------------

const POSTCONDITIONS: Record<string, PostconditionRule> = {
  set_tempo: setTempo,
  set_track_mixer: setTrackMixer,
  set_track_state: setTrackState,
  rename_track: renameTrack,
  create_midi_track: createTrack,
  create_audio_track: createTrack,
  insert_device: insertDevice,
  set_device_parameter: setDeviceParameter,
  write_midi_clip: writeMidiClip,
  write_session_clip: writeSessionClip,
  set_clip_notes: setClipNotes,
};

/** Postconditions for one executed tool call; [] when the tool is unverified.
 * A rule bug must never reach the tool loop — a throwing rule yields no specs. */
export function postconditionsFor(
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): CheckSpec[] {
  const rule = POSTCONDITIONS[name];
  if (!rule) return [];
  try {
    return rule(input, result);
  } catch {
    return [];
  }
}
