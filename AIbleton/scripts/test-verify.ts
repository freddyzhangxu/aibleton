/**
 * Fixture-based test for src/verify/ (postcondition verification).
 * Run: npx tsx scripts/test-verify.ts
 *
 * All fixtures are plain ProbeSong objects — no Live, no SDK. Some numeric
 * fields are deliberately BigInt to simulate the Extension Host bridge.
 */
import { postconditionsFor } from "../src/verify/rules.js";
import { runVerification } from "../src/verify/verifier.js";
import type { ProbeClip, ProbeDevice, ProbeParam, ProbeSong, ProbeTrack } from "../src/verify/types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const param = (name: string, value: unknown, valueItems?: { name: string }[]): ProbeParam => ({
  name,
  valueItems,
  getValue: () => Promise.resolve(value),
});

function track(name: string, opt: Partial<ProbeTrack> = {}): ProbeTrack {
  return {
    name,
    mute: opt.mute ?? false,
    solo: opt.solo ?? false,
    arm: opt.arm ?? false,
    devices: opt.devices ?? [],
    mixer: opt.mixer ?? { volume: param("Volume", 0.85), panning: param("Pan", 0) },
    arrangementClips: opt.arrangementClips ?? [],
    clipSlots: opt.clipSlots ?? [],
  };
}

const clip = (startTime: unknown, duration: unknown, notes: number, name = "clip"): ProbeClip => ({
  name,
  startTime: startTime as number,
  duration: duration as number,
  notes: Array.from({ length: notes }, (_, i) => ({ pitch: 36 + i })),
});

const song = (tracks: ProbeTrack[], tempo: unknown = 120): ProbeSong => ({
  tempo: tempo as number,
  tracks,
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failed = 0;
let passed = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (cond) passed++;
  else failed++;
}

/** Run one tool's postconditions against a fixture song. */
async function verify(
  tool: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  fx: ProbeSong,
) {
  const specs = postconditionsFor(tool, input, result);
  return runVerification(fx, specs);
}

// ---------------------------------------------------------------------------
console.log("== set_tempo ==");
{
  const ok = await verify("set_tempo", { bpm: 128 }, { tempo: 128 }, song([], 128));
  check("匹配 → success", ok.success);

  // Bridge 真实行为：getter 返回 BigInt
  const big = await verify("set_tempo", { bpm: 128 }, { tempo: 128 }, song([], BigInt(128)));
  check("BigInt tempo 归一化 → success", big.success);

  const bad = await verify("set_tempo", { bpm: 128 }, { tempo: 128 }, song([], 120));
  check("不匹配 → fail + remainingIssues", !bad.success && bad.remainingIssues.length === 1,
    JSON.stringify(bad.remainingIssues));
}

console.log("== set_track_mixer ==");
{
  const fx = song([track("Bass", { mixer: { volume: param("Volume", 0.6), panning: param("Pan", -0.5) } })]);
  const ok = await verify("set_track_mixer", { track_index: 0, volume: 0.6, pan: -0.5 },
    { track: "Bass", volume: 0.6, pan: -0.5, track_index: 0 }, fx);
  check("volume+pan 匹配 → success（2 checks）", ok.success && ok.checks.length === 2);

  const drift = await verify("set_track_mixer", { track_index: 0, volume: 0.6 },
    { track: "Bass", volume: 0.6, track_index: 0 },
    song([track("Bass", { mixer: { volume: param("Volume", 0.85), panning: param("Pan", 0) } })]));
  check("值未生效（仍是 0.85）→ fail", !drift.success && /实际 0\.85/.test(drift.remainingIssues[0]),
    drift.remainingIssues.join("|"));

  const gone = await verify("set_track_mixer", { track_index: 3, volume: 0.6 },
    { track: "X", volume: 0.6, track_index: 3 }, fx);
  check("轨道越界 → fail（不抛异常）", !gone.success);
}

console.log("== set_track_state / rename_track / create_track ==");
{
  const ok = await verify("set_track_state", { index: 0, mute: true },
    { track: "Bass", mute: true, solo: false, arm: false, track_index: 0 },
    song([track("Bass", { mute: true })]));
  check("mute 匹配 → success", ok.success);

  const bad = await verify("set_track_state", { index: 0, solo: true },
    { track: "Bass", mute: false, solo: true, arm: false, track_index: 0 }, song([track("Bass")]));
  check("solo 未生效 → fail", !bad.success);

  const rn = await verify("rename_track", { index: 0, name: "Sub Bass" },
    { renamed: "Bass", to: "Sub Bass", track_index: 0 }, song([track("Sub Bass")]));
  check("rename 匹配 → success", rn.success);

  const ct = await verify("create_midi_track", { name: "Pads" }, { created: "Pads", type: "MIDI" },
    song([track("Pads")]));
  check("create 匹配 → success", ct.success);
  const ctBad = await verify("create_audio_track", {}, { created: "Aux", type: "Audio" }, song([]));
  check("create 未出现 → fail", !ctBad.success);
}

console.log("== insert_device / set_device_parameter ==");
{
  const autoFilter: ProbeDevice = {
    name: "Auto Filter",
    parameters: [
      param("Frequency", 800),
      param("Type", 1, [{ name: "Lowpass" }, { name: "Bandpass" }, { name: "Highpass" }]),
    ],
  };
  const fx = song([track("Bass", { devices: [autoFilter] })]);

  const ins = await verify("insert_device", { index: 0, device_name: "auto filter" },
    { inserted: "Auto Filter", into: "Bass", track_index: 0 }, fx);
  check("insert 后设备存在 → success", ins.success);

  const insBad = await verify("insert_device", { index: 0, device_name: "Reverb" },
    { inserted: "Reverb", into: "Bass", track_index: 0 }, fx);
  check("insert 未出现 → fail（列出实际设备）",
    !insBad.success && /Auto Filter/.test(insBad.remainingIssues[0]));

  const num = await verify("set_device_parameter",
    { track_index: 0, device_name: "auto", parameter: "freq", value: "800" },
    { device: "Auto Filter", parameter: "Frequency", value: 800, range: [20, 20000], track_index: 0 }, fx);
  check("数值参数匹配 → success", num.success);

  const numBad = await verify("set_device_parameter",
    { track_index: 0, device_name: "auto", parameter: "freq", value: "800" },
    { device: "Auto Filter", parameter: "Frequency", value: 800, range: [20, 20000], track_index: 0 },
    song([track("Bass", { devices: [{ ...autoFilter, parameters: [param("Frequency", BigInt(1200)), autoFilter.parameters[1]] }] })]));
  check("数值参数不符（BigInt 1200）→ fail", !numBad.success && /1200/.test(numBad.remainingIssues[0]));

  const text = await verify("set_device_parameter",
    { track_index: 0, device_name: "auto", parameter: "type", value: "bandpass" },
    { device: "Auto Filter", parameter: "Type", value: "Bandpass", range: [0, 2], track_index: 0 }, fx);
  check("枚举文本参数匹配（index→name）→ success", text.success);

  const textBad = await verify("set_device_parameter",
    { track_index: 0, device_name: "auto", parameter: "type", value: "highpass" },
    { device: "Auto Filter", parameter: "Type", value: "Highpass", range: [0, 2], track_index: 0 }, fx);
  check("枚举文本不符 → fail", !textBad.success);
}

console.log("== write_midi_clip / write_session_clip / set_clip_notes ==");
{
  const fx = song([track("Drums", {
    arrangementClips: [clip(BigInt(16), 16, 28, "beat")],
    clipSlots: [{ clip: clip(0, 8, 12, "sess") }, { clip: null }],
  })]);

  const ok = await verify("write_midi_clip",
    { track_index: 0, start_beat: 16, length_beats: 16, notes: "x" },
    { clip: "beat", start: 16, length: 16, noteCount: 28, swing: 0, track_index: 0 }, fx);
  check("clip 存在+长度+音符数（BigInt startTime）→ success", ok.success);

  const fewer = await verify("write_midi_clip",
    { track_index: 0, start_beat: 16, length_beats: 16, notes: "x" },
    { clip: "beat", start: 16, length: 16, noteCount: 32, swing: 0, track_index: 0 }, fx);
  check("音符数不符 → fail", !fewer.success && /音符数=28/.test(fewer.remainingIssues[0]),
    fewer.remainingIssues.join("|"));

  const missing = await verify("write_midi_clip",
    { track_index: 0, start_beat: 64, length_beats: 16, notes: "x" },
    { clip: "beat", start: 64, length: 16, noteCount: 10, swing: 0, track_index: 0 }, fx);
  check("起始位置无 clip → fail", !missing.success && /没有 clip/.test(missing.remainingIssues[0]));

  const sess = await verify("write_session_clip",
    { track_index: 0, scene_index: 0, length_beats: 8, notes: "x" },
    { clip: "sess", length: 8, noteCount: 12, swing: 0, track_index: 0 }, fx);
  check("session clip 匹配 → success", sess.success);

  const sessEmpty = await verify("write_session_clip",
    { track_index: 0, scene_index: 1, length_beats: 8, notes: "x" },
    { clip: "sess", length: 8, noteCount: 5, swing: 0, track_index: 0 }, fx);
  check("session 槽位为空 → fail", !sessEmpty.success);

  const sn = await verify("set_clip_notes",
    { track_index: 0, clip_index: 0, notes: "x" },
    { clip: "beat", noteCount: 28, track_index: 0 }, fx);
  check("set_clip_notes 匹配 → success", sn.success);
}

console.log("== 兜底行为 ==");
{
  check("无规则工具 → 0 specs", postconditionsFor("get_song_overview", {}, {}).length === 0);
  check("缺字段不炸 → 0 specs 或正常",
    postconditionsFor("set_track_mixer", {}, {}).length >= 0);

  const boom = await runVerification(song([]), [{
    id: "boom",
    expected: "x",
    probe: () => { throw new Error("bridge gone"); },
  }]);
  check("probe 抛异常 → failed check（不炸调用方）",
    !boom.success && /probe 异常: bridge gone/.test(boom.remainingIssues[0]),
    boom.remainingIssues.join("|"));
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 项失败 / ${passed + failed}` : `\n全部通过 (${passed})`);
process.exit(failed ? 1 : 0);
