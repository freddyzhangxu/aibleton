/**
 * Fixture-based test for src/plan/ (Plan layer).
 * Run: npx tsx scripts/test-plan.ts
 *
 * Effect judges and step-execution replay are exercised against literal
 * GoalView objects and plain tool-name logs (no Live, no SDK); the end-to-end
 * block runs SongSnapshot fixtures through buildMusicState + buildGoalView,
 * the same measurement path server.ts's goal gate uses.
 */
import { normalizePlan, type MusicPlan, type PlanStep } from "../src/plan/types.js";
import { buildPlanReport, checkEffect, executedStepIds } from "../src/plan/check.js";
import { buildGoalView, type GoalView } from "../src/goal/view.js";
import { evaluateGoal } from "../src/goal/evaluate.js";
import { buildMusicState } from "../src/musicstate/builder.js";
import type { SnapshotClip, SnapshotNote, SnapshotTrack, SongSnapshot } from "../src/musicstate/types.js";

const VALID_TOOLS = new Set([
  "analyze_song",
  "create_midi_track",
  "write_midi_clip",
  "insert_device",
  "set_device_parameter",
  "arrange_song",
]);

// ---------------------------------------------------------------------------
// Literal GoalView builders (same fixture shape as test-goal.ts)
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

/** Pre-change baseline: thinner Drop, no bass audible in it. */
const before = gv({
  tracks: [
    { name: "Drums", role: "drums", notes: 20, muted: false },
    { name: "Bass", role: "bass", notes: 8, muted: false },
  ],
  sections: [
    { name: "Intro", bars: [1, 4], notes: 4, density: 1, tracks: 1, roles: new Set(["drums"]) },
    { name: "Drop", bars: [5, 8], notes: 24, density: 6, tracks: 1, roles: new Set(["drums"]) },
  ],
  songRoles: new Set(["drums", "bass"]),
});
const after = gv();

const plan = (steps: PlanStep[]): MusicPlan => ({
  goal: {
    type: "arrange",
    objective: "make the drop harder",
    constraints: [],
    successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" }],
  },
  steps,
});

const step = (over: Partial<PlanStep> & { description: string }): PlanStep => ({
  id: over.id ?? "step-1",
  expectedEffects: [],
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
console.log("== normalizePlan ==");
{
  const ok = normalizePlan(
    {
      steps: [
        { description: "Inspect drop section", tool: "analyze_song" },
        {
          id: "hats",
          description: "Add open-hat pattern to the drop",
          tool: "write_midi_clip",
          args: { track: "Drums", start_bar: 5 },
          expectedEffects: [{ metric: "section_energy", direction: "increase", section: "Drop" }],
        },
        {
          description: "Make bass audible in drop",
          tool: "write_midi_clip",
          expectedEffect: [{ metric: "role_audible", role: "low-end", section: "Drop" }], // singular spelling
        },
      ],
    },
    VALID_TOOLS,
  );
  check("3 步全部保留", !!ok.steps && ok.steps.length === 3);
  check("缺 id → 自动分配 step-N", !!ok.steps && ok.steps[0].id === "step-1" && ok.steps[2].id === "step-3");
  check("提供的 id 保留", !!ok.steps && ok.steps[1].id === "hats");
  check("expectedEffect（单数拼写）也被接受 + role 归一化 low_end",
    !!ok.steps && ok.steps[2].expectedEffects[0]?.metric === "role_audible" && ok.steps[2].expectedEffects[0]?.role === "low_end");
  check("无效果的步骤 → expectedEffects=[]", !!ok.steps && ok.steps[0].expectedEffects.length === 0);

  const junk = normalizePlan(
    {
      steps: [
        { description: "Bad tool", tool: "make_it_banger" },
        { description: "Bad metric", expectedEffects: [{ metric: "vibe", direction: "increase" }] },
        { description: "Missing section", expectedEffects: [{ metric: "section_energy", direction: "increase" }] },
        { description: "Missing direction", expectedEffects: [{ metric: "tempo" }] },
        { description: "Missing role", expectedEffects: [{ metric: "role_audible", direction: "increase" }] },
        { description: "Missing track", expectedEffects: [{ metric: "track_notes", direction: "increase" }] },
        { tool: "write_midi_clip" }, // no description
        "not-an-object",
        { description: "Survivor", tool: "insert_device", expectedEffects: [{ metric: "track_count", direction: "increase" }] },
      ],
    },
    VALID_TOOLS,
  );
  // 9 条输入：无 description 的和非对象的被丢弃，其余 7 条保留（坏 tool 置空、坏效果丢弃）。
  check("垃圾步骤/效果全丢弃、合法步骤保留 + warnings",
    !!junk.steps && junk.steps.length === 7 && junk.warnings.length >= 7,
    `steps=${junk.steps?.length} warnings=${junk.warnings.length}: ${junk.warnings.join(" | ")}`);
  check("未知 tool → 置空但步骤保留",
    !!junk.steps && junk.steps[0].tool === undefined && junk.steps[0].description === "Bad tool");
  check("全部效果非法的步骤仍保留（effects=[]）",
    !!junk.steps && junk.steps.slice(1, 6).every((s) => s.expectedEffects.length === 0));

  const empty = normalizePlan({ steps: [{ tool: "x" }, "junk"] }, VALID_TOOLS);
  check("零有效步骤 → steps=null", empty.steps === null);

  const notArray = normalizePlan({ steps: "do stuff" }, VALID_TOOLS);
  check("steps 非数组 → steps=null", notArray.steps === null);

  const caps = normalizePlan(
    {
      steps: Array.from({ length: 15 }, (_, i) => ({ description: `s${i}` })),
    },
    VALID_TOOLS,
  );
  check("超过 12 步截断 + warning", !!caps.steps && caps.steps.length === 12 && caps.warnings.length === 1);

  const bigArgs = normalizePlan(
    { steps: [{ description: "x", tool: "write_midi_clip", args: { notes: "n".repeat(3000) } }] },
    VALID_TOOLS,
  );
  check("超大 args 丢弃 + warning", !!bigArgs.steps && bigArgs.steps[0].args === undefined && bigArgs.warnings.length === 1);
}

// ---------------------------------------------------------------------------
console.log("== checkEffect: section_energy / section_tracks ==");
{
  const up = checkEffect({ metric: "section_energy", direction: "increase", section: "Drop" }, before, after);
  check("Drop 密度 6→10 increase → observed", up.observed, up.actual);
  const down = checkEffect({ metric: "section_energy", direction: "decrease", section: "Drop" }, before, after);
  check("同数据 decrease → not observed", !down.observed);
  const flat = checkEffect({ metric: "section_energy", direction: "increase", section: "Intro" }, before, after);
  check("Intro 密度 1→1 increase → not observed（严格大于）", !flat.observed, flat.actual);
  const tracks = checkEffect({ metric: "section_tracks", direction: "increase", section: "Drop" }, before, after);
  check("Drop 参与轨数 1→2 increase → observed", tracks.observed, tracks.actual);

  const missing = checkEffect({ metric: "section_energy", direction: "increase", section: "Bridge" }, before, after);
  check("目标段落不存在 → not observed 且列出可用段落",
    !missing.observed && /Intro/.test(missing.actual ?? "") && /Drop/.test(missing.actual ?? ""), missing.actual);
  const noBase = checkEffect(
    { metric: "section_energy", direction: "increase", section: "Drop" },
    gv({ sections: [] }), // baseline lost the section
    after,
  );
  check("基线中无此段落 → not observed", !noBase.observed && /基线/.test(noBase.expected));
}

// ---------------------------------------------------------------------------
console.log("== checkEffect: track_notes / track_count / tempo ==");
{
  const notes = checkEffect({ metric: "track_notes", direction: "increase", track: "Drums" }, before, after);
  check("Drums 音符 20→36 increase → observed", notes.observed, notes.actual);
  const noMove = checkEffect({ metric: "track_notes", direction: "increase", track: "Bass" }, before, after);
  check("Bass 音符 8→8 → not observed", !noMove.observed);

  const born = checkEffect(
    { metric: "track_notes", direction: "increase", track: "Arp" },
    before,
    gv({ trackCount: 3, tracks: [...gv().tracks, { name: "Arp", role: "lead", notes: 32, muted: false }] }),
  );
  check("新轨道基线按 0 计 → 0→32 observed", born.observed, born.actual);

  const gone = checkEffect({ metric: "track_notes", direction: "increase", track: "Ghost" }, before, after);
  check("轨道不存在 → not observed 且列出现有轨道", !gone.observed && /Drums/.test(gone.actual ?? ""));

  check("track_count 2→3 increase → observed",
    checkEffect({ metric: "track_count", direction: "increase" }, before, gv({ trackCount: 3 })).observed);
  check("track_count 2→2 increase → not observed",
    !checkEffect({ metric: "track_count", direction: "increase" }, before, after).observed);
  check("tempo 128→140 increase → observed",
    checkEffect({ metric: "tempo", direction: "increase" }, before, gv({ tempo: 140 })).observed);
  check("tempo 128→120 decrease → observed",
    checkEffect({ metric: "tempo", direction: "decrease" }, before, gv({ tempo: 120 })).observed);
}

// ---------------------------------------------------------------------------
console.log("== checkEffect: role_audible ==");
{
  const low = checkEffect({ metric: "role_audible", role: "low_end", section: "Drop" }, before, after);
  check("low_end @ Drop（after 有 bass）→ observed", low.observed);
  const intro = checkEffect({ metric: "role_audible", role: "low_end", section: "Intro" }, before, after);
  check("low_end @ Intro → not observed 且列出现有角色", !intro.observed && /drums/.test(intro.actual ?? ""));
  const song = checkEffect({ metric: "role_audible", role: "vocal" }, before, after);
  check("vocal @ 全曲 → not observed", !song.observed);
  const noSec = checkEffect({ metric: "role_audible", role: "bass", section: "Bridge" }, before, after);
  check("段落不存在 → not observed", !noSec.observed);
}

// ---------------------------------------------------------------------------
console.log("== executedStepIds（工具日志回放）==");
{
  const steps = [
    step({ id: "inspect", description: "Inspect", tool: "analyze_song" }),
    step({ id: "hats", description: "Hats", tool: "write_midi_clip" }),
    step({ id: "bass", description: "Bass", tool: "write_midi_clip" }),
    step({ id: "fx", description: "Impact FX", tool: "insert_device" }),
    step({ id: "verify", description: "Verify contrast" }), // no tool
  ];
  const full = executedStepIds(steps, ["analyze_song", "write_midi_clip", "write_midi_clip", "insert_device"]);
  check("全执行 → 4 个带 tool 的步骤全标记（无 tool 步骤不匹配）",
    full.size === 4 && !full.has("verify"), [...full].join(","));

  const skipped = executedStepIds(steps, ["write_midi_clip", "insert_device"]);
  check("跳步：第一次 write_midi_clip 给 hats，fx 命中，inspect 未执行",
    skipped.has("hats") && skipped.has("fx") && !skipped.has("inspect") && !skipped.has("bass"),
    [...skipped].join(","));

  const cursor = executedStepIds(steps, ["write_midi_clip", "write_midi_clip"]);
  check("同名工具按声明顺序消耗：两次 write_midi_clip → hats + bass",
    cursor.has("hats") && cursor.has("bass") && cursor.size === 2);

  const extra = executedStepIds(steps, ["set_track_mixer", "analyze_song"]);
  check("计划外的调用被忽略、不阻塞后续匹配", extra.has("inspect") && extra.size === 1);

  const none = executedStepIds(steps, []);
  check("空日志 → 全未执行", none.size === 0);
}

// ---------------------------------------------------------------------------
console.log("== buildPlanReport 聚合 ==");
{
  const p = plan([
    step({ id: "inspect", description: "Inspect drop", tool: "analyze_song" }),
    step({
      id: "hats",
      description: "Add hats",
      tool: "write_midi_clip",
      expectedEffects: [
        { metric: "section_energy", direction: "increase", section: "Drop" },
        { metric: "section_tracks", direction: "increase", section: "Drop" },
      ],
    }),
    step({
      id: "fx",
      description: "Add impact FX",
      tool: "insert_device",
      expectedEffects: [{ metric: "track_count", direction: "increase" }],
    }),
  ]);
  const rep = buildPlanReport(p, ["analyze_song", "write_midi_clip"], before, after);
  check("3 步执行 2 步；fx 未执行", rep.total === 3 && rep.executedCount === 2 && rep.unexecuted.length === 1 && rep.unexecuted[0].id === "fx");
  check("hats 两个效果都观察到 → unobserved 只剩 fx 的 track_count",
    rep.unobserved.length === 1 && rep.unobserved[0].stepId === "fx" && rep.unobserved[0].id === "trackCount",
    rep.unobserved.map((u) => `${u.stepId}:${u.id}`).join("|"));
  check("unobserved 带步骤归因（stepId + description）",
    rep.unobserved[0].description === "Add impact FX");

  const same = buildPlanReport(p, ["analyze_song", "write_midi_clip", "insert_device"], before, before);
  check("全执行但状态没变 → 效果全未观察到（3 条）",
    same.unexecuted.length === 0 && same.unobserved.length === 3,
    same.unobserved.map((u) => u.id).join("|"));
}

// ---------------------------------------------------------------------------
// End-to-end: SongSnapshot -> buildMusicState -> GoalView -> plan report,
// plus agreement with the goal judge on the same views.
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

console.log("== 端到端（SongSnapshot → 计划报告）==");
{
  // Baseline: Drums over 8 bars (kick per bar in Intro, per beat in Drop),
  // Bass only in the Intro. Drop cue at bar 5 (beat 16).
  const drumNotes: SnapshotNote[] = [];
  for (let b = 0; b < 4; b++) drumNotes.push(n(36, b * 4)); // intro kick: 4
  for (let b = 16; b < 32; b++) drumNotes.push(n(36, b)); // drop kick: 16
  const bassIntro = midiClip([n(36, 0, 1), n(36, 3, 1)], { start: 0, duration: 16, name: "intro bass" });
  const baseFx = snapSong(
    [
      snapTrack(0, "Drums", [midiClip(drumNotes, { start: 0, duration: 32, name: "beat" })]),
      snapTrack(1, "Bass", [bassIntro]),
    ],
    { cuePoints: [{ time: 16, name: "Drop" }] },
  );
  const baseView = buildGoalView(buildMusicState(baseFx));

  // After: hats added over the Drop, bass extended across the Drop.
  const denser = drumNotes.concat(Array.from({ length: 16 }, (_, i) => n(42, 16 + i + 0.5)));
  const bassDrop = midiClip([n(36, 0, 1), n(36, 3, 1)], {
    start: 16, duration: 16, looping: true, loopStart: 0, loopEnd: 4, name: "drop bass",
  });
  const afterFx = snapSong(
    [
      snapTrack(0, "Drums", [midiClip(denser, { start: 0, duration: 32, name: "beat" })]),
      snapTrack(1, "Bass", [bassIntro, bassDrop]),
    ],
    { cuePoints: [{ time: 16, name: "Drop" }] },
  );
  const afterView = buildGoalView(buildMusicState(afterFx));

  const p = plan([
    step({ id: "inspect", description: "Inspect drop section", tool: "analyze_song" }),
    step({
      id: "hats",
      description: "Add open-hat pattern to the drop",
      tool: "write_midi_clip",
      expectedEffects: [
        { metric: "section_energy", direction: "increase", section: "Drop" },
        { metric: "track_notes", direction: "increase", track: "Drums" },
      ],
    }),
    step({
      id: "bass",
      description: "Extend bass into the drop",
      tool: "write_midi_clip",
      expectedEffects: [{ metric: "role_audible", role: "low_end", section: "Drop" }],
    }),
    step({
      id: "impact",
      description: "Add impact FX before drop",
      tool: "insert_device",
      expectedEffects: [{ metric: "track_count", direction: "increase" }],
    }),
  ]);

  const rep = buildPlanReport(p, ["analyze_song", "write_midi_clip", "write_midi_clip"], baseView, afterView);
  check("执行 3/4 步；impact 未执行", rep.executedCount === 3 && rep.unexecuted[0]?.id === "impact");
  check("hats 效果观察到（Drop 密度上升）",
    rep.steps[1].effects.every((e) => e.observed), rep.steps[1].effects.map((e) => `${e.id}:${e.observed}`).join("|"));
  check("bass 效果观察到（Drop 出现 low_end）",
    rep.steps[2].effects.every((e) => e.observed), rep.steps[2].effects.map((e) => `${e.id}:${e.observed}`).join("|"));
  check("唯一未观察 = impact 的 track_count", rep.unobserved.length === 1 && rep.unobserved[0].stepId === "impact");

  // Agreement: goal criterion and plan effect judge the SAME numbers.
  const ev = evaluateGoal(p.goal, baseView, afterView);
  check("与目标判定一致：section_energy_gt Drop>baseline:Drop 通过", ev.met,
    [...ev.constraintIssues, ...ev.criteriaIssues].join("|") || "met");
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 项失败 / ${passed + failed}` : `\n全部通过 (${passed})`);
process.exit(failed ? 1 : 0);
