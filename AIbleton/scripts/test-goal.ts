/**
 * Fixture-based test for src/goal/ (Goal/Intent layer).
 * Run: npx tsx scripts/test-goal.ts
 *
 * Judges are exercised against literal GoalView objects (no Live, no SDK);
 * buildGoalView is exercised end-to-end from SongSnapshot fixtures through
 * buildMusicState, the same path server.ts runs at goal declare/gate time.
 */
import { normalizeGoal, type MusicGoal } from "../src/goal/types.js";
import { buildGoalView, type GoalView } from "../src/goal/view.js";
import { evaluateGoal } from "../src/goal/evaluate.js";
import { buildMusicState } from "../src/musicstate/builder.js";
import type { SnapshotClip, SnapshotNote, SnapshotTrack, SongSnapshot } from "../src/musicstate/types.js";

// ---------------------------------------------------------------------------
// Literal GoalView builders (judge unit tests)
// ---------------------------------------------------------------------------

function gv(over: Partial<GoalView> = {}): GoalView {
  return {
    tempo: 128,
    keyBest: "A minor",
    trackCount: 2,
    tracks: [
      { name: "Drums", role: "drums", notes: 36, muted: false },
      { name: "Bass", role: "bass", notes: 8, muted: false },
    ],
    sections: [
      { name: "Intro", bars: [1, 4], notes: 4, density: 1, tracks: 1, roles: new Set(["drums"]) },
      { name: "Drop", bars: [5, 8], notes: 40, density: 10, tracks: 2, roles: new Set(["drums", "bass"]) },
    ],
    songRoles: new Set(["drums", "bass"]),
    ...over,
  };
}

/** Same song, but the Drop is thinner (the pre-change baseline). */
const before = gv({
  sections: [
    { name: "Intro", bars: [1, 4], notes: 4, density: 1, tracks: 1, roles: new Set(["drums"]) },
    { name: "Drop", bars: [5, 8], notes: 24, density: 6, tracks: 1, roles: new Set(["drums"]) },
  ],
});
const after = gv();

const goal = (over: Partial<MusicGoal> = {}): MusicGoal => ({
  type: "arrange",
  objective: "make the drop harder",
  constraints: [],
  successCriteria: [],
  ...over,
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

// ---------------------------------------------------------------------------
console.log("== normalizeGoal ==");
{
  const ok = normalizeGoal({
    type: "arrange",
    objective: "make the drop harder",
    target: { section: "Drop" },
    successCriteria: [
      { kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" },
      { kind: "role_present", role: "low-end", section: "Drop" },
    ],
    constraints: [{ kind: "tempo_unchanged" }, { kind: "tracks_untouched", names: [" Vocal ", ""] }],
  });
  check("完整输入 → goal + 2 criteria + 2 constraints",
    !!ok.goal && ok.goal.successCriteria.length === 2 && ok.goal.constraints.length === 2);
  check("role 归一化 low-end → low_end",
    ok.goal?.successCriteria[1].kind === "role_present" && ok.goal.successCriteria[1].role === "low_end");
  check("tracks_untouched 过滤空名",
    ok.goal?.constraints[1].kind === "tracks_untouched" && ok.goal.constraints[1].names.length === 1);

  const junk = normalizeGoal({
    type: "remix",
    successCriteria: [
      { kind: "make_it_banger" },
      { kind: "section_energy_gt", a: "Drop" }, // 缺 b
      { kind: "track_count_gte", n: "lots" }, // n 非法
      { kind: "track_count_gte", n: "baseline" },
      "not-an-object",
    ],
  });
  check("垃圾条目全丢弃、合法条目保留 + warnings",
    !!junk.goal && junk.goal.successCriteria.length === 1 && junk.warnings.length >= 4,
    junk.warnings.join(" | "));
  check("未知 type → edit + warning", junk.goal?.type === "edit");

  const empty = normalizeGoal({ type: "edit", objective: "x", successCriteria: [] });
  check("零有效条件 → goal=null", empty.goal === null);
}

// ---------------------------------------------------------------------------
console.log("== section_energy_gt ==");
{
  const g = goal({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "Intro" }] });
  check("Drop(10) > Intro(1) → met", evaluateGoal(g, before, after).met);
  check("Intro > Drop → unmet",
    !evaluateGoal(goal({ successCriteria: [{ kind: "section_energy_gt", a: "Intro", b: "Drop" }] }), before, after).met);

  const base = evaluateGoal(goal({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" }] }), before, after);
  check("Drop(10) > 基线 Drop(6) → met", base.met);
  check("after == before → unmet（严格大于）",
    !evaluateGoal(goal({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" }] }), before, before).met);

  const missing = evaluateGoal(goal({ successCriteria: [{ kind: "section_energy_gt", a: "Breakdown", b: "Intro" }] }), before, after);
  check("目标段落不存在 → fail 且列出可用段落",
    !missing.met && /Intro/.test(missing.criteriaIssues[0]) && /Drop/.test(missing.criteriaIssues[0]),
    missing.criteriaIssues.join("|"));

  const noBase = evaluateGoal(goal({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "baseline:Bridge" }] }), before, after);
  check("基线中无此段落 → fail", !noBase.met && /基线/.test(noBase.criteriaIssues[0]));
}

// ---------------------------------------------------------------------------
console.log("== section_tracks_gte / role_present ==");
{
  check("Drop tracks(2) ≥ 2 → met",
    evaluateGoal(goal({ successCriteria: [{ kind: "section_tracks_gte", section: "Drop", n: 2 }] }), before, after).met);
  check("Drop tracks(2) ≥ 3 → unmet",
    !evaluateGoal(goal({ successCriteria: [{ kind: "section_tracks_gte", section: "Drop", n: 3 }] }), before, after).met);
  check("Drop tracks ≥ 基线(1) → met",
    evaluateGoal(goal({ successCriteria: [{ kind: "section_tracks_gte", section: "Drop", n: "baseline" }] }), before, after).met);

  check("low_end(kick|bass) @ Drop → met",
    evaluateGoal(goal({ successCriteria: [{ kind: "role_present", role: "low_end", section: "Drop" }] }), before, after).met);
  const noLow = evaluateGoal(goal({ successCriteria: [{ kind: "role_present", role: "low_end", section: "Intro" }] }), before, after);
  check("low_end @ Intro → unmet 且列出现有角色",
    !noLow.met && /drums/.test(noLow.criteriaIssues[0]), noLow.criteriaIssues.join("|"));
  check("vocal @ 全曲 → unmet",
    !evaluateGoal(goal({ successCriteria: [{ kind: "role_present", role: "vocal" }] }), before, after).met);
  check("bass @ 全曲 → met",
    evaluateGoal(goal({ successCriteria: [{ kind: "role_present", role: "bass" }] }), before, after).met);
}

// ---------------------------------------------------------------------------
console.log("== tempo / key / track count ==");
{
  check("tempo_unchanged 128→128 → met",
    evaluateGoal(goal({ constraints: [{ kind: "tempo_unchanged" }] }), before, after).met);
  const faster = gv({ tempo: 140 });
  const ev = evaluateGoal(goal({ constraints: [{ kind: "tempo_unchanged" }] }), before, faster);
  check("tempo_unchanged 128→140 → 记入 constraintIssues（非 criteriaIssues）",
    !ev.met && ev.constraintIssues.length === 1 && ev.criteriaIssues.length === 0);

  check("key_unchanged 相同 → met",
    evaluateGoal(goal({ constraints: [{ kind: "key_unchanged" }] }), before, after).met);
  check("key_unchanged 变了 → unmet",
    !evaluateGoal(goal({ constraints: [{ kind: "key_unchanged" }] }), before, gv({ keyBest: "C major" })).met);
  check("key_unchanged 两边都无法检测 → met",
    evaluateGoal(goal({ constraints: [{ kind: "key_unchanged" }] }), gv({ keyBest: undefined }), gv({ keyBest: undefined })).met);

  check("track_count_gte baseline(2) vs 2 → met",
    evaluateGoal(goal({ successCriteria: [{ kind: "track_count_gte", n: "baseline" }] }), before, after).met);
  check("track_count_gte 4 → unmet",
    !evaluateGoal(goal({ successCriteria: [{ kind: "track_count_gte", n: 4 }] }), before, after).met);
  check("no_new_tracks 2→2 → met",
    evaluateGoal(goal({ constraints: [{ kind: "no_new_tracks" }] }), before, after).met);
  check("no_new_tracks 2→3 → unmet",
    !evaluateGoal(goal({ constraints: [{ kind: "no_new_tracks" }] }), before, gv({ trackCount: 3 })).met);
}

// ---------------------------------------------------------------------------
console.log("== tracks_untouched ==");
{
  const g = goal({ constraints: [{ kind: "tracks_untouched", names: ["Drums", "Bass"] }] });
  check("内容不变 → met", evaluateGoal(g, before, after).met);

  const touched = gv({
    tracks: [
      { name: "Drums", role: "drums", notes: 99, muted: false },
      { name: "Bass", role: "bass", notes: 8, muted: false },
    ],
  });
  const ev = evaluateGoal(g, before, touched);
  check("Drums 音符数变了 → unmet 且点名 Drums",
    !ev.met && /Drums/.test(ev.constraintIssues[0]) && /36 → 99/.test(ev.constraintIssues[0]),
    ev.constraintIssues.join("|"));

  const deleted = gv({
    trackCount: 1,
    tracks: [{ name: "Bass", role: "bass", notes: 8, muted: false }],
  });
  check("轨道被删 → unmet（已不存在）",
    !evaluateGoal(g, before, deleted).met);
}

// ---------------------------------------------------------------------------
console.log("== evaluateGoal 聚合 ==");
{
  const g = goal({
    constraints: [{ kind: "tempo_unchanged" }],
    successCriteria: [
      { kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" },
      { kind: "role_present", role: "low_end", section: "Drop" },
    ],
  });
  const ev = evaluateGoal(g, before, after);
  check("全过 → met, checks=3", ev.met && ev.checks.length === 3);

  // 同一份 view 做 before/after：energy 严格大于必然不过；before 的 Drop
  // 也只有 drums，role_present 同样不过 → 2 条 criteriaIssue、0 条 constraintIssue。
  const half = evaluateGoal(g, before, before);
  check("未过项全部归入 criteriaIssues、约束不误伤",
    !half.met && half.criteriaIssues.length === 2 && half.constraintIssues.length === 0,
    JSON.stringify(half.criteriaIssues));
}

// ---------------------------------------------------------------------------
// buildGoalView end-to-end: SongSnapshot -> buildMusicState -> GoalView
// ---------------------------------------------------------------------------

const n = (pitch: number, start: number, duration = 0.25, velocity = 100): SnapshotNote =>
  ({ pitch, start, duration, velocity });

function midiClip(notes: SnapshotNote[], opt: Partial<SnapshotClip> & { start: number | null }): SnapshotClip {
  const duration = opt.duration ?? 16;
  return {
    kind: "midi",
    name: opt.name ?? "clip",
    start: opt.start,
    duration,
    looping: opt.looping ?? false,
    loopStart: opt.loopStart ?? 0,
    loopEnd: opt.loopEnd ?? duration,
    startMarker: opt.startMarker ?? 0,
    muted: opt.muted ?? false,
    notes,
  };
}

function snapTrack(index: number, name: string, clips: SnapshotClip[], opt: Partial<SnapshotTrack> = {}): SnapshotTrack {
  return {
    index, name,
    type: opt.type ?? "midi",
    mute: opt.mute ?? false,
    mutedViaSolo: opt.mutedViaSolo ?? false,
    devices: opt.devices ?? [],
    clips,
  };
}

function snapSong(tracks: SnapshotTrack[], opt: Partial<SongSnapshot> = {}): SongSnapshot {
  return {
    tempo: opt.tempo ?? 128,
    timeSig: { numerator: 4, denominator: 4 },
    liveScale: { mode: false, root: 0, name: "", intervals: [] },
    cuePoints: opt.cuePoints ?? [],
    sceneCount: 0,
    tracks,
  };
}

console.log("== buildGoalView（SongSnapshot 端到端）==");
{
  // Drums: 8 bars. Intro (bars 1-4) = kick on each bar; Drop (bars 5-8) =
  // kick every beat + hats on offbeats. Bass: looping 1-bar riff over the Drop.
  const drumNotes: SnapshotNote[] = [];
  for (let b = 0; b < 4; b++) drumNotes.push(n(36, b * 4)); // intro: 4
  for (let b = 16; b < 32; b++) drumNotes.push(n(36, b)); // drop kick: 16
  for (let b = 16; b < 32; b++) drumNotes.push(n(42, b + 0.5)); // drop hats: 16
  const bassClip = midiClip([n(36, 0, 1), n(36, 3, 1)], {
    start: 16, duration: 16, looping: true, loopStart: 0, loopEnd: 4, name: "bass riff",
  });
  const vocalClip = midiClip([n(60, 0, 2), n(62, 4, 2)], { start: 0, duration: 16, name: "vox" });

  const songFx = snapSong(
    [
      snapTrack(0, "Drums", [midiClip(drumNotes, { start: 0, duration: 32, name: "beat" })]),
      snapTrack(1, "Bass", [bassClip]),
      snapTrack(2, "Vocal", [vocalClip], { mute: true }),
    ],
    { cuePoints: [{ time: 16, name: "Drop" }] },
  );
  const view = buildGoalView(buildMusicState(songFx));

  const intro = view.sections.find((s) => s.name === "Intro");
  const drop = view.sections.find((s) => s.name === "Drop");
  check("段落 = Intro + Drop（cue 派生）", !!intro && !!drop,
    view.sections.map((s) => s.name).join(","));
  check("Intro 密度 1/bar（4 notes / 4 bars）", !!intro && Math.abs(intro.density - 1) < 1e-6,
    `density=${intro?.density}`);
  // Drop: 32 drum onsets + 8 bass onsets (2-note loop x 4 tiles) = 40 / 4 bars
  check("Drop 密度 10/bar（40 notes / 4 bars，bass loop 已平铺）", !!drop && Math.abs(drop.density - 10) < 1e-6,
    `density=${drop?.density} notes=${drop?.notes}`);
  check("Drop 参与轨数 = 2", !!drop && drop.tracks === 2, `tracks=${drop?.tracks}`);
  check("Drop 角色含 bass（loop 平铺归因）", !!drop && drop.roles.has("bass"),
    [...(drop?.roles ?? [])].join(","));
  check("Intro 角色不含 bass", !!intro && !intro.roles.has("bass"));
  check("trackCount=3，songRoles 排除 muted Vocal",
    view.trackCount === 3 && view.songRoles.has("drums") && view.songRoles.has("bass") && !view.songRoles.has("vocal"),
    [...view.songRoles].join(","));

  // Same song with a beefed-up drop → baseline comparison passes.
  const denser = drumNotes.concat(Array.from({ length: 16 }, (_, i) => n(38, 16 + i * 0.5)));
  const afterFx = snapSong(
    [
      snapTrack(0, "Drums", [midiClip(denser, { start: 0, duration: 32, name: "beat" })]),
      snapTrack(1, "Bass", [bassClip]),
      snapTrack(2, "Vocal", [vocalClip], { mute: true }),
    ],
    { cuePoints: [{ time: 16, name: "Drop" }] },
  );
  const afterView = buildGoalView(buildMusicState(afterFx));
  const g = goal({
    successCriteria: [
      { kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" },
      { kind: "role_present", role: "low_end", section: "Drop" },
      { kind: "section_tracks_gte", section: "Drop", n: "baseline" },
    ],
    constraints: [{ kind: "tracks_untouched", names: ["Bass"] }, { kind: "no_new_tracks" }],
  });
  const ev = evaluateGoal(g, view, afterView);
  check("端到端：drop 加密后 5 条全过 → met", ev.met,
    [...ev.constraintIssues, ...ev.criteriaIssues].join("|") || "all passed");
}

// ---------------------------------------------------------------------------
// Audio criteria: track_crest_gte / track_band_gte (judge clip SOURCE FILES)
// ---------------------------------------------------------------------------
console.log("== audio criteria ==");
import { goalNeedsAudio } from "../src/goal/types.js";
import type { AudioFeatures } from "../src/dsp.js";
{
  const ok = normalizeGoal({
    type: "sound_design",
    objective: "make the kick punchier",
    successCriteria: [
      { kind: "track_crest_gte", track: "Kick", db: 6 },
      { kind: "track_band_gte", track: "Bass", band: "sub", pct: 0.3 },
    ],
  });
  check("两个音频判据合法接受", !!ok.goal && ok.goal.successCriteria.length === 2, ok.warnings.join(" | "));
  check("goalNeedsAudio → true", !!ok.goal && goalNeedsAudio(ok.goal));

  const junk = normalizeGoal({
    type: "sound_design",
    objective: "x",
    successCriteria: [
      { kind: "track_band_gte", track: "Bass", band: "treble", pct: 0.3 }, // band 非法
      { kind: "track_band_gte", track: "Bass", band: "sub", pct: 1.5 }, // pct 越界
      { kind: "track_crest_gte", db: 6 }, // 缺 track
      { kind: "track_crest_gte", track: "Kick", db: 6 },
    ],
  });
  check("坏 band / pct 越界 / 缺 track 全部丢弃", !!junk.goal && junk.goal.successCriteria.length === 1 && junk.warnings.length === 3,
    junk.warnings.join(" | "));
  const nonAudio = goal({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "Intro" }] });
  check("goalNeedsAudio → false（无音频判据）", !goalNeedsAudio(nonAudio));
}

const audioBands = { sub: 0.2, bass: 0.3, lowMid: 0.2, mid: 0.15, highMid: 0.1, high: 0.05 };
const gvAudio = (crestDb: number, bands = audioBands): GoalView =>
  gv({
    tracks: [
      { name: "Drums", role: "drums", notes: 36, muted: false },
      { name: "Bass", role: "bass", notes: 8, muted: false, audio: { crestDb, rmsDb: -12, bands } },
    ],
  });

{
  const gCrest = goal({ successCriteria: [{ kind: "track_crest_gte", track: "Bass", db: 6 }] });
  check("crest 7 ≥ 6 → met", evaluateGoal(gCrest, before, gvAudio(7)).met);
  const low = evaluateGoal(gCrest, before, gvAudio(2.5));
  check("crest 2.5 < 6 → unmet 且报实际值", !low.met && /2\.5 dB/.test(low.criteriaIssues[0]), low.criteriaIssues.join("|"));

  const noTrack = evaluateGoal(goal({ successCriteria: [{ kind: "track_crest_gte", track: "Ghost", db: 6 }] }), before, gvAudio(9));
  check("轨道不存在 → fail 且列出可用轨道", !noTrack.met && /Drums/.test(noTrack.criteriaIssues[0]), noTrack.criteriaIssues.join("|"));

  const noAudio = evaluateGoal(gCrest, before, gv()); // 无 audio 字段的 view
  check("未启用音频分析 → fail 且说明原因", !noAudio.met && /无音频特征/.test(noAudio.criteriaIssues[0]), noAudio.criteriaIssues.join("|"));

  const gBand = goal({ successCriteria: [{ kind: "track_band_gte", track: "Bass", band: "sub", pct: 0.15 }] });
  check("sub 0.2 ≥ 0.15 → met", evaluateGoal(gBand, before, gvAudio(9)).met);
  check("sub 0.2 < 0.25 → unmet",
    !evaluateGoal(goal({ successCriteria: [{ kind: "track_band_gte", track: "Bass", band: "sub", pct: 0.25 }] }), before, gvAudio(9)).met);
}

// End-to-end: snapshot -> buildMusicState -> attach ClipState.audio (what
// enrichment writes) -> buildGoalView -> evaluateGoal.
{
  const audioClip: SnapshotClip = {
    kind: "audio", name: "kick loop", start: 0, duration: 16,
    looping: true, loopStart: 0, loopEnd: 16, startMarker: 0, muted: false,
    file: "kick.wav", filePath: "/tmp/kick.wav",
  };
  const audioFeat = (crestDb: number): AudioFeatures => ({
    durationSec: 8, sampleRate: 44100, channels: 2,
    rmsDb: -10, peakDb: -3, crestDb, loudnessDb: -12, dynamicRangeDb: 8,
    spectralCentroidHz: 2500,
    bands: { sub: 0.4, bass: 0.3, lowMid: 0.1, mid: 0.1, highMid: 0.05, high: 0.05 },
    transientDensity: 4,
  });
  const audioSong = snapSong([snapTrack(0, "Kick", [audioClip], { type: "audio" })]);
  const viewWith = (crestDb: number): GoalView => {
    const st = buildMusicState(audioSong);
    st.tracks[0].clips[0].audio = { features: audioFeat(crestDb) };
    return buildGoalView(st);
  };
  const soft = viewWith(2);
  const punchy = viewWith(7.5);
  check("端到端：GoalView 携带音频聚合", soft.tracks[0].audio?.crestDb === 2, JSON.stringify(soft.tracks[0].audio));
  const g = goal({ successCriteria: [{ kind: "track_crest_gte", track: "Kick", db: 6 }] });
  check("端到端：换更猛的采样后 gate 通过", evaluateGoal(g, soft, punchy).met);
  check("端到端：采样没换（压缩器动不了源文件）→ 不通过", !evaluateGoal(g, soft, soft).met);
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 项失败 / ${passed + failed}` : `\n全部通过 (${passed})`);
process.exit(failed ? 1 : 0);
