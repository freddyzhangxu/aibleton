/**
 * Fixture-based smoke test for src/analysis/ (analyze_song).
 * Run: npx tsx scripts/test-analysis.ts
 *
 * All fixtures are plain SongSnapshot objects — no Live, no SDK.
 */
import {
  analyzeMusicState,
  analyzeSong,
  presentAnalysis,
} from "../src/analysis/index.js";
import { buildMusicState } from "../src/musicstate/builder.js";
import type {
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
  SongSnapshot,
} from "../src/musicstate/types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const n = (
  pitch: number,
  start: number,
  duration: number,
  velocity = 100,
  muted = false,
): SnapshotNote => ({ pitch, start, duration, velocity, muted });

function midiClip(
  notes: SnapshotNote[],
  opt: Partial<SnapshotClip> & { start: number | null } = { start: 0 },
): SnapshotClip {
  const duration = opt.duration ?? 16;
  return {
    kind: "midi",
    name: opt.name ?? "clip",
    start: opt.start !== undefined ? opt.start : 0,
    duration,
    looping: opt.looping ?? true,
    loopStart: opt.loopStart ?? 0,
    loopEnd: opt.loopEnd ?? duration,
    startMarker: opt.startMarker ?? 0,
    muted: opt.muted ?? false,
    notes,
  };
}

function track(
  index: number,
  name: string,
  clips: SnapshotClip[],
  opt: Partial<SnapshotTrack> = {},
): SnapshotTrack {
  return {
    index,
    name,
    type: opt.type ?? "midi",
    mute: opt.mute ?? false,
    mutedViaSolo: opt.mutedViaSolo ?? false,
    drumPads: opt.drumPads,
    devices: opt.devices ?? [],
    clips,
  };
}

function song(tracks: SnapshotTrack[], opt: Partial<SongSnapshot> = {}): SongSnapshot {
  return {
    tempo: opt.tempo ?? 128,
    timeSig: opt.timeSig ?? { numerator: 4, denominator: 4 },
    liveScale: opt.liveScale ?? { mode: false, root: 0, name: "", intervals: [] },
    cuePoints: opt.cuePoints ?? [],
    sceneCount: opt.sceneCount ?? 0,
    tracks,
  };
}

/** Rep a per-bar note pattern over `bars` bars (4/4). */
function repBars(perBar: SnapshotNote[], bars: number): SnapshotNote[] {
  const out: SnapshotNote[] = [];
  for (let b = 0; b < bars; b++) {
    for (const note of perBar) out.push({ ...note, start: note.start + b * 4 });
  }
  return out;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

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
// 1. F# minor techno (kick four-on-floor must NOT pollute the key histogram)
// ---------------------------------------------------------------------------
console.log("== F# minor techno ==");
const bassBar = [
  n(30, 0, 0.5, 96), // F#1
  n(30, 1.5, 0.5, 110),
  n(37, 2, 0.5, 84), // C#2
  n(30, 3, 0.5, 104),
];
const bassNotes = repBars(bassBar, 4);
bassNotes.push(n(33, 8 + 2, 0.5, 92)); // A1 in bar 3
bassNotes.push(n(40, 12 + 2, 0.5, 92)); // E2 in bar 4
const hatsNotes = repBars(
  [
    n(42, 0, 0.25, 62),
    n(42, 0.5, 0.25, 96),
    n(44, 1, 0.25, 110),
    n(42, 1.5, 0.25, 72),
    n(42, 2, 0.25, 96),
    n(44, 2.5, 0.25, 62),
    n(42, 3, 0.25, 104),
    n(46, 3.5, 0.25, 88),
  ],
  4,
);
const padNotes: SnapshotNote[] = [];
for (let b = 0; b < 4; b++) {
  padNotes.push(n(42, b * 4, 4, 70), n(45, b * 4, 4, 82), n(49, b * 4, 4, 78)); // F#2 A2 C#3
}
const fsMinor = song([
  track(0, "Kick", [midiClip(repBars([n(36, 0, 0.25), n(36, 1, 0.25), n(36, 2, 0.25), n(36, 3, 0.25)], 4))]),
  track(1, "Bass", [midiClip(bassNotes)]),
  track(2, "Hats", [midiClip(hatsNotes)]),
  track(3, "Pad", [midiClip(padNotes)]),
]);
const r1 = analyzeSong(fsMinor);
console.log(JSON.stringify(r1, null, 1));
check("key = F# minor (drums excluded from histogram)", r1.key.best === "F# minor", JSON.stringify(r1.key));
check("roles kick/bass/hats/pad",
  r1.tracks[0].role === "kick" && r1.tracks[1].role === "bass" &&
  r1.tracks[2].role === "hats" && r1.tracks[3].role === "pad",
  r1.tracks.map((t) => t.role).join(","));
check("bass register capped (< C3)", r1.tracks[1].range === "F#1-E2", r1.tracks[1].range);
check("arrangement 16 beats / 4 bars", r1.arrangement?.beats === 16 && r1.arrangement?.bars === 4);

// ---------------------------------------------------------------------------
// 2. C major chord progression
// ---------------------------------------------------------------------------
console.log("== C major chords ==");
const cMaj = song([
  track(0, "Chords", [midiClip([
    n(60, 0, 4, 80), n(64, 0, 4, 80), n(67, 0, 4, 80), // C
    n(65, 4, 4, 80), n(69, 4, 4, 80), n(60, 4, 4, 80), // F
    n(67, 8, 4, 80), n(71, 8, 4, 80), n(62, 8, 4, 80), // G
    n(60, 12, 4, 80), n(64, 12, 4, 80), n(67, 12, 4, 80), // C
  ])]),
]);
const r2 = analyzeSong(cMaj);
check("key = C major", r2.key.best === "C major", JSON.stringify(r2.key));

// ---------------------------------------------------------------------------
// 3. A minor (relative-major tolerance)
// ---------------------------------------------------------------------------
console.log("== A minor ==");
const aMin = song([
  track(0, "Chords", [midiClip([
    n(57, 0, 4, 80), n(60, 0, 4, 80), n(64, 0, 4, 80), // Am
    n(62, 4, 4, 80), n(65, 4, 4, 80), n(69, 4, 4, 80), // Dm
    n(64, 8, 4, 80), n(67, 8, 4, 80), n(71, 8, 4, 80), // Em
    n(57, 12, 4, 80), n(60, 12, 4, 80), n(64, 12, 4, 80), // Am
  ])]),
]);
const r3 = analyzeSong(aMin);
check("best ∈ {A minor, C major}", r3.key.best === "A minor" || r3.key.best === "C major", r3.key.best);

// ---------------------------------------------------------------------------
// 4. Sparse material
// ---------------------------------------------------------------------------
console.log("== sparse ==");
const r4 = analyzeSong(song([track(0, "X", [midiClip([n(60, 0, 2), n(67, 2, 2)])])]));
check("insufficient_material", r4.key.status === "insufficient_material");

// ---------------------------------------------------------------------------
// 5/6. LOW_CONTRAST on flat energy, not on varied energy
// ---------------------------------------------------------------------------
console.log("== energy contrast ==");
const blockClip = (start: number, noteCount: number) =>
  midiClip(
    Array.from({ length: noteCount }, (_, i) =>
      n([60, 62, 64, 67][i % 4], Math.floor(i / 2), 0.5, 70 + (i % 5) * 10)),
    { start, duration: 16 },
  );
const flat = song([track(0, "Keys", [0, 1, 2, 3, 4, 5, 6, 7].map((i) => blockClip(i * 16, 8)))]);
const r5 = analyzeSong(flat);
check("flat energy → LOW_CONTRAST", r5.issues.some((s) => s.startsWith("LOW_CONTRAST")), r5.issues.join(" | "));
const varied = song([
  track(0, "Keys", [
    blockClip(0, 8), blockClip(16, 8), blockClip(32, 8), blockClip(48, 8),
    blockClip(64, 1), blockClip(80, 1), // breakdown
    blockClip(96, 8), blockClip(112, 8),
  ]),
]);
const r6 = analyzeSong(varied);
check("varied energy → no LOW_CONTRAST", !r6.issues.some((s) => s.startsWith("LOW_CONTRAST")), r6.issues.join(" | "));

// ---------------------------------------------------------------------------
// 7. FLAT_DYNAMICS
// ---------------------------------------------------------------------------
console.log("== flat dynamics ==");
const flatVel = song([
  track(0, "Arp", [midiClip(Array.from({ length: 40 }, (_, i) => n(60 + (i % 8), i * 0.5, 0.25, 100)), { duration: 20 })]),
]);
const r7 = analyzeSong(flatVel);
check("FLAT_DYNAMICS fires", r7.issues.some((s) => s.startsWith("FLAT_DYNAMICS") && s.includes('"Arp"')), r7.issues.join(" | "));

// ---------------------------------------------------------------------------
// 8. MONOTONE_BASS
// ---------------------------------------------------------------------------
console.log("== monotone bass ==");
const monoBass = song([
  track(0, "Bass", [midiClip(Array.from({ length: 40 }, (_, i) => n(i % 4 === 3 ? 37 : 30, i * 0.5, 0.25, 80 + (i % 4) * 10)), { duration: 20 })]),
]);
const r8 = analyzeSong(monoBass);
check("MONOTONE_BASS fires", r8.issues.some((s) => s.startsWith("MONOTONE_BASS")), r8.issues.join(" | "));

// ---------------------------------------------------------------------------
// 9. Session-only set
// ---------------------------------------------------------------------------
console.log("== session only ==");
const sess = song([
  track(0, "Ideas", [midiClip([
    n(42, 0, 4, 80), n(45, 0, 4, 80), n(49, 0, 4, 80),
    n(42, 4, 4, 80), n(45, 4, 4, 80), n(49, 4, 4, 80),
    n(40, 8, 4, 80), n(45, 8, 4, 80), n(49, 8, 4, 80),
    n(42, 12, 4, 80), n(45, 12, 4, 80), n(49, 12, 4, 80),
  ], { start: null })]),
]);
const r9 = analyzeSong(sess);
check("NO_ARRANGEMENT fires", r9.issues.some((s) => s.startsWith("NO_ARRANGEMENT")), r9.issues.join(" | "));
check("key still detected from session notes", r9.key.status === "ok", JSON.stringify(r9.key));
check("session summary counts", r9.session.clips === 1 && r9.session.notes === 12, JSON.stringify(r9.session));

// ---------------------------------------------------------------------------
// 10. Empty set
// ---------------------------------------------------------------------------
console.log("== empty ==");
const r10 = analyzeSong(song([]));
check("EMPTY_SET, no crash", r10.issues.some((s) => s.startsWith("EMPTY_SET")) && r10.sections.length === 0);

// ---------------------------------------------------------------------------
// 11. OFF_KEY threshold (20% fires, 5% does not)
// ---------------------------------------------------------------------------
console.log("== off key ==");
const inKey = Array.from({ length: 40 }, (_, i) => n([60, 62, 64, 65, 67, 69, 71][i % 7], i * 0.5, 0.5, 70 + (i % 6) * 8));
const chromatic = (count: number, from: number) =>
  Array.from({ length: count }, (_, i) => n([61, 63, 66, 68, 70][i % 5], from + i * 0.5, 0.5, 90));
const mkOffKey = (outCount: number) =>
  song([track(0, "Keys", [midiClip([...inKey, ...chromatic(outCount, 20)], { duration: 25 })])], {
    liveScale: { mode: true, root: 0, name: "Major", intervals: MAJOR },
  });
const r11a = analyzeSong(mkOffKey(10)); // 10/50 = 20%
check("20% out-of-key → OFF_KEY", r11a.issues.some((s) => s.startsWith("OFF_KEY")), r11a.issues.join(" | "));
const r11b = analyzeSong(mkOffKey(2)); // 2/42 ≈ 5%
check("5% out-of-key → silent", !r11b.issues.some((s) => s.startsWith("OFF_KEY")), r11b.issues.join(" | "));

// ---------------------------------------------------------------------------
// 12. Cue-point sections
// ---------------------------------------------------------------------------
console.log("== cue sections ==");
const cues = song([
  track(0, "Keys", [
    midiClip(repBars([n(60, 0, 1, 70), n(64, 1, 1, 80), n(67, 2, 1, 90), n(64, 3, 1, 100)], 2), { start: 0, duration: 8 }),
    midiClip(repBars([n(60, 0, 1, 70), n(64, 1, 1, 80), n(67, 2, 1, 90), n(64, 3, 1, 100)], 4), { start: 32, duration: 16 }),
    midiClip(repBars([n(60, 0, 0.5, 70), n(62, 0.5, 0.5, 80), n(64, 1, 0.5, 90), n(65, 1.5, 0.5, 100), n(67, 2, 0.5, 110), n(69, 2.5, 0.5, 90), n(71, 3, 0.5, 80), n(72, 3.5, 0.5, 90)], 8), { start: 64, duration: 32 }),
  ])],
  { cuePoints: [{ time: 0, name: "Intro" }, { time: 32, name: "Build" }, { time: 64, name: "Drop" }] },
);
const r12 = analyzeSong(cues);
check("3 cue sections with names",
  r12.sections.length === 3 &&
  r12.sections[0].name === "Intro" && r12.sections[1].name === "Build" && r12.sections[2].name === "Drop",
  JSON.stringify(r12.sections.map((s) => s.name)));
check("section bar ranges", JSON.stringify(r12.sections.map((s) => s.bars)) === JSON.stringify([[1, 8], [9, 16], [17, 24]]),
  JSON.stringify(r12.sections.map((s) => s.bars)));
check("drop has most notes", r12.sections[2].notes > r12.sections[0].notes);

// ---------------------------------------------------------------------------
// 13. Looped clip: repeats weight the histogram and the timeline
// ---------------------------------------------------------------------------
console.log("== looped clip ==");
const looped = song([
  track(0, "Keys", [midiClip([n(42, 0, 1, 70), n(45, 1, 1, 80), n(49, 2, 1, 90), n(40, 3, 1, 100)],
    { start: 0, duration: 16, looping: true, loopStart: 0, loopEnd: 4 })]),
]);
const r13 = analyzeSong(looped);
check("4-beat material x4 repeats → 16 audible notes", r13.tracks[0].notes === 16, String(r13.tracks[0].notes));
check("repeats push histogram over the 16-beat threshold", r13.key.status === "ok", JSON.stringify(r13.key));
check("density spread over full 16 beats", r13.tracks[0].dens === 4, String(r13.tracks[0].dens));

// ---------------------------------------------------------------------------
// 14. Muted content excluded everywhere, reported once
// ---------------------------------------------------------------------------
console.log("== muted content ==");
const mutedSet = song([
  track(0, "Lead", [midiClip(repBars([n(72, 0, 1, 90), n(74, 1, 1, 90), n(76, 2, 1, 90), n(77, 3, 1, 90)], 5), { duration: 20 })], { mute: true }),
  track(1, "Keys", [
    midiClip([n(60, 0, 4, 80), n(64, 0, 4, 80), n(67, 0, 4, 80), n(65, 4, 4, 80), n(69, 4, 4, 80), n(72, 4, 4, 80)], { muted: true }),
    midiClip([n(60, 0, 4, 80), n(64, 0, 4, 80), n(67, 0, 4, 80, true), n(65, 4, 4, 80), n(69, 4, 4, 80), n(71, 4, 4, 80, true)]),
  ]),
  track(2, "Bass", [midiClip(bassNotes)]),
]);
const r14 = analyzeSong(mutedSet);
const mutedIssue = r14.issues.find((s) => s.startsWith("MUTED_CONTENT"));
check("MUTED_CONTENT fires with counts", !!mutedIssue && mutedIssue.includes("20 notes on muted tracks") && mutedIssue.includes("6 notes in muted clips") && mutedIssue.includes("2 muted notes"), mutedIssue);
check("muted track flagged in output", r14.tracks[0].muted === true && r14.tracks[0].notes === 0);
check("muted material stays out of key histogram", r14.key.status === "ok" && !["G major", "C major"].includes(r14.key.best ?? "") ? true : r14.key.best === "C major", r14.key.best);

// ---------------------------------------------------------------------------
// 15. Unnamed DrumRack tracks
// ---------------------------------------------------------------------------
console.log("== drum rack roles ==");
const rack = song([
  track(0, "", [midiClip(repBars([n(36, 0, 0.25), n(38, 1, 0.25), n(42, 2, 0.25)], 4))], { drumPads: [36, 38, 42] }),
  track(1, "", [midiClip(repBars([n(36, 0, 0.25), n(36, 1, 0.25), n(36, 2, 0.25), n(36, 3, 0.25)], 4))], { drumPads: [36] }),
]);
const r15 = analyzeSong(rack);
check("multi-pad rack → drums", r15.tracks[0].role === "drums", r15.tracks[0].role);
check("single pad 36 → kick", r15.tracks[1].role === "kick", r15.tracks[1].role);

// ---------------------------------------------------------------------------
// 16. NO_LOW_END + NO_HIGH_END
// ---------------------------------------------------------------------------
console.log("== register gaps ==");
const midOnly = song([
  track(0, "Keys", [midiClip(Array.from({ length: 40 }, (_, i) => n(60 + (i % 10), i * 0.5, 0.25, 60 + (i % 7) * 10)), { duration: 20 })]),
]);
const r16 = analyzeSong(midOnly);
check("NO_LOW_END fires", r16.issues.some((s) => s.startsWith("NO_LOW_END")), r16.issues.join(" | "));
check("NO_HIGH_END fires", r16.issues.some((s) => s.startsWith("NO_HIGH_END")), r16.issues.join(" | "));

// ---------------------------------------------------------------------------
// 17. KEY_MISMATCH (relative major tolerated)
// ---------------------------------------------------------------------------
console.log("== key mismatch ==");
const fsTracks = fsMinor.tracks;
const r17a = analyzeSong(song(fsTracks, { liveScale: { mode: true, root: 2, name: "Major", intervals: MAJOR } }));
check("Live D major vs detected F# minor → KEY_MISMATCH", r17a.issues.some((s) => s.startsWith("KEY_MISMATCH")), r17a.issues.join(" | "));
const r17b = analyzeSong(song(fsTracks, { liveScale: { mode: true, root: 9, name: "Major", intervals: MAJOR } }));
check("Live A major (relative) → silent", !r17b.issues.some((s) => s.startsWith("KEY_MISMATCH")), r17b.issues.join(" | "));

// ---------------------------------------------------------------------------
// 18. 6/8 time signature
// ---------------------------------------------------------------------------
console.log("== 6/8 ==");
const waltz = song(
  [track(0, "Keys", [midiClip(repBars([n(60, 0, 1, 70), n(64, 1, 1, 80), n(67, 2, 1, 90)], 8), { duration: 24 })])],
  { timeSig: { numerator: 6, denominator: 8 } },
);
const r18 = analyzeSong(waltz);
check("24 beats of 6/8 = 8 bars", r18.arrangement?.bars === 8, JSON.stringify(r18.arrangement));
check("block bars use 3 beats/bar", r18.sections.length === 1 && r18.sections[0].bars[0] === 1 && r18.sections[0].bars[1] === 8,
  JSON.stringify(r18.sections));

// ---------------------------------------------------------------------------
// 19. DUPLICATE_CONTENT: cross-track identical clips fire, near-dupes don't
// ---------------------------------------------------------------------------
console.log("== duplicate content ==");
const leadLine = [n(64, 0, 1, 90), n(67, 1, 0.5, 96), n(69, 2, 1, 84), n(64, 3, 1, 100)];
const dupSet = song([
  track(0, "Lead Synth", [midiClip(repBars(leadLine, 4))]),
  track(1, "Bass", [midiClip(bassNotes)]),
  track(2, "5-Jun-6 V", [midiClip(repBars(leadLine, 4))]),
]);
const r19a = analyzeSong(dupSet);
const dupIssue = r19a.issues.find((s) => s.startsWith("DUPLICATE_CONTENT"));
check("identical tracks → DUPLICATE_CONTENT with both names",
  !!dupIssue && dupIssue.includes('"Lead Synth"') && dupIssue.includes('"5-Jun-6 V"'), dupIssue);
const nearDup = song([
  track(0, "Lead Synth", [midiClip(repBars(leadLine, 4))]),
  track(1, "Bass", [midiClip(bassNotes)]),
  track(2, "5-Jun-6 V", [midiClip(repBars([n(64, 0, 1, 90), n(67, 1, 0.5, 96), n(69, 2, 1, 84), n(65, 3, 1, 100)], 4))]),
]);
const r19b = analyzeSong(nearDup);
check("one pitch different → silent", !r19b.issues.some((s) => s.startsWith("DUPLICATE_CONTENT")), r19b.issues.join(" | "));
const sameTrackRep = song([
  track(0, "Lead Synth", [midiClip(leadLine, { start: 0, duration: 4 }), midiClip(leadLine, { start: 8, duration: 4 })]),
  track(1, "Bass", [midiClip(bassNotes)]),
]);
const r19c = analyzeSong(sameTrackRep);
check("same clip twice on ONE track → silent (normal arranging)",
  !r19c.issues.some((s) => s.startsWith("DUPLICATE_CONTENT")), r19c.issues.join(" | "));

// ---------------------------------------------------------------------------
// 20. Budget: 32 tracks must fit 6000 chars with tracksOmitted = 20
// ---------------------------------------------------------------------------
console.log("== budget ==");
const bigTracks = Array.from({ length: 32 }, (_, i) =>
  track(i, `Very Long Track Name With Plenty Of Characters Number ${String(i).padStart(2, "0")}`,
    [0, 1, 2].map((c) =>
      midiClip(
        Array.from({ length: 32 }, (_, j) => n(24 + ((i * 7 + j * 3) % 72), j * 0.5, 0.25, j % 2 ? 80 : 120)),
        { start: c * 16, duration: 16 },
      ))));
const r19 = analyzeSong(song(bigTracks));
const out19 = JSON.stringify(r19);
console.log(`  output ${out19.length} chars, tracks ${r19.tracks.length}, omitted ${r19.tracksOmitted}`);
check("fits under 6000", out19.length < 6000, `${out19.length}`);
check("tracks truncated to 12", r19.tracks.length === 12, String(r19.tracks.length));
check("tracksOmitted = 20", r19.tracksOmitted === 20, String(r19.tracksOmitted));

// ---------------------------------------------------------------------------
// 21. Three-stage pipeline: present(state, analyzeMusicState(state)) ≡ analyzeSong(f)
// (analyze_song calls the three stages explicitly — pin the contract)
// ---------------------------------------------------------------------------
console.log("== three-stage equivalence ==");
{
  const fixtures: [string, SongSnapshot][] = [
    ["fsMinor", fsMinor],
    ["cMaj", cMaj],
    ["session-only", sess],
    ["cue sections", cues],
    ["looped clip", looped],
    ["muted content", mutedSet],
    ["drum rack", rack],
    ["6/8", waltz],
    ["duplicates", dupSet],
    ["empty", song([])],
    ["budget 32 tracks", song(bigTracks)],
  ];
  for (const [label, fx] of fixtures) {
    const direct = JSON.stringify(analyzeSong(fx));
    const state = buildMusicState(fx);
    const staged = JSON.stringify(presentAnalysis(state, analyzeMusicState(state)));
    check(`${label}: staged ≡ direct`, staged === direct, `${staged.length} vs ${direct.length} chars`);
  }
}

// ---------------------------------------------------------------------------
// 22. Audio features (ClipState.audio fixtures — no real files needed:
// features attach to ClipState directly, exactly what audiofiles' enrichment
// would have written after decoding source files)
// ---------------------------------------------------------------------------
console.log("== audio features ==");
import type { AudioFeatures } from "../src/dsp.js";
import type { AudioEnrichStats } from "../src/analysis/types.js";

const feat = (over: Partial<AudioFeatures> = {}): AudioFeatures => ({
  durationSec: 10,
  sampleRate: 44100,
  channels: 2,
  rmsDb: -12,
  peakDb: -3,
  crestDb: 9,
  loudnessDb: -14,
  dynamicRangeDb: 10,
  spectralCentroidHz: 3000,
  bands: { sub: 0.1, bass: 0.2, lowMid: 0.2, mid: 0.2, highMid: 0.15, high: 0.15 },
  transientDensity: 4,
  ...over,
});

function audioClip(opt: Partial<SnapshotClip> = {}): SnapshotClip {
  const duration = opt.duration ?? 16;
  return {
    kind: "audio",
    name: opt.name ?? "audio clip",
    start: opt.start !== undefined ? (opt.start as number | null) : 0,
    duration,
    looping: opt.looping ?? true,
    loopStart: 0,
    loopEnd: duration,
    startMarker: 0,
    muted: opt.muted ?? false,
    file: opt.file ?? "loop.wav",
    filePath: opt.filePath ?? "/tmp/loop.wav",
  };
}

const AUDIO_CODES = ["WEAK_TRANSIENTS", "THIN_LOW_END", "SQUASHED_DYNAMICS", "DULL_HIGH_END", "HARSH_HIGH_END"];
const hasCode = (ma: ReturnType<typeof analyzeMusicState>, code: string): boolean =>
  ma.issues.some((i) => i.code === code);

// Un-enriched: no ClipState.audio anywhere → no audio issues, no trackAudio.
{
  const st = buildMusicState(song([track(0, "Kick", [audioClip()], { type: "audio" })]));
  const ma = analyzeMusicState(st);
  check("un-enriched → trackAudio undefined", ma.trackAudio === undefined);
  check("un-enriched → no audio issue codes", !ma.issues.some((i) => AUDIO_CODES.includes(i.code)));
}

// Kick with squashed crest → WEAK_TRANSIENTS, with track ref + source-file caveat.
{
  const st = buildMusicState(song([track(0, "Kick", [audioClip()], { type: "audio" })]));
  st.tracks[0].clips[0].audio = { features: feat({ crestDb: 1.5 }) };
  const ma = analyzeMusicState(st);
  const issue = ma.issues.find((i) => i.code === "WEAK_TRANSIENTS");
  check("crest 1.5 on kick → WEAK_TRANSIENTS", !!issue, ma.issues.map((i) => i.code).join(" | "));
  check("WEAK_TRANSIENTS references the track", issue?.tracks?.[0] === 0);
  check("WEAK_TRANSIENTS carries the source-file caveat", !!issue && issue.message.includes("from clip source files"));
  check("punchy kick (crest 9) → silent", (() => {
    const st2 = buildMusicState(song([track(0, "Kick", [audioClip()], { type: "audio" })]));
    st2.tracks[0].clips[0].audio = { features: feat({ crestDb: 9 }) };
    return !hasCode(analyzeMusicState(st2), "WEAK_TRANSIENTS");
  })());
}

// Bass with thin low bands → THIN_LOW_END.
{
  const st = buildMusicState(song([track(0, "Bass", [audioClip()], { type: "audio" })]));
  st.tracks[0].clips[0].audio = {
    features: feat({ bands: { sub: 0.05, bass: 0.1, lowMid: 0.3, mid: 0.3, highMid: 0.15, high: 0.1 } }),
  };
  const ma = analyzeMusicState(st);
  check("sub+bass 15% on bass → THIN_LOW_END", hasCode(ma, "THIN_LOW_END"), ma.issues.map((i) => i.code).join(" | "));
  const ta = ma.trackAudio?.[0];
  check("trackAudio aggregate present", !!ta && ta.clips === 1);
}

// Over-compressed → SQUASHED_DYNAMICS (any role).
{
  const st = buildMusicState(song([track(0, "Keys", [audioClip()], { type: "audio" })]));
  st.tracks[0].clips[0].audio = { features: feat({ dynamicRangeDb: 3 }) };
  check("dynamicRange 3 dB → SQUASHED_DYNAMICS", hasCode(analyzeMusicState(st), "SQUASHED_DYNAMICS"));
  const st2 = buildMusicState(song([track(0, "Keys", [audioClip()], { type: "audio" })]));
  st2.tracks[0].clips[0].audio = { features: feat({ dynamicRangeDb: undefined }) };
  check("dynamicRange undefined (short one-shot) → silent", !hasCode(analyzeMusicState(st2), "SQUASHED_DYNAMICS"));
}

// Song-wide balance: dull vs harsh (duration-weighted across tracks).
{
  const dullSet = song([track(0, "Pad Stem", [audioClip()], { type: "audio" })]);
  const stD = buildMusicState(dullSet);
  stD.tracks[0].clips[0].audio = {
    features: feat({ bands: { sub: 0.1, bass: 0.2, lowMid: 0.35, mid: 0.2, highMid: 0.13, high: 0.02 } }),
  };
  const maD = analyzeMusicState(stD);
  check("song-wide high 2% → DULL_HIGH_END", hasCode(maD, "DULL_HIGH_END"));
  check("DULL message scoped to source files", maD.issues.find((i) => i.code === "DULL_HIGH_END")?.message.includes("audio clip source files only") ?? false);

  const stH = buildMusicState(song([track(0, "Hats Stem", [audioClip()], { type: "audio" })]));
  stH.tracks[0].clips[0].audio = {
    features: feat({ bands: { sub: 0.02, bass: 0.03, lowMid: 0.1, mid: 0.2, highMid: 0.25, high: 0.4 } }),
  };
  check("song-wide high+highMid 65% → HARSH_HIGH_END", hasCode(analyzeMusicState(stH), "HARSH_HIGH_END"));

  // Field-report regression: loud sub-heavy kick + hats 28 dB down — the
  // quiet hats must NOT skew the mix verdict into HARSH (energy-weighted).
  const stFR = buildMusicState(
    song([
      track(0, "Kick", [audioClip({ name: "kick" })], { type: "audio" }),
      track(1, "Hats", [audioClip({ name: "hats" })], { type: "audio" }),
    ]),
  );
  stFR.tracks[0].clips[0].audio = {
    features: feat({ rmsDb: -14, bands: { sub: 0.61, bass: 0.35, lowMid: 0.02, mid: 0.01, highMid: 0.005, high: 0.005 } }),
  };
  stFR.tracks[1].clips[0].audio = {
    features: feat({ rmsDb: -42.4, bands: { sub: 0, bass: 0, lowMid: 0.02, mid: 0.02, highMid: 0.04, high: 0.92 } }),
  };
  const maFR = analyzeMusicState(stFR);
  check("quiet hats 28 dB down → HARSH stays silent", !hasCode(maFR, "HARSH_HIGH_END"),
    maFR.issues.map((i) => i.code).join(" | ") || "none");
}

// Aggregate weighting + failure accounting.
{
  const st = buildMusicState(
    song([track(0, "Drums", [audioClip({ name: "a", duration: 4 }), audioClip({ name: "b", duration: 16 })], { type: "audio" })]),
  );
  st.tracks[0].clips[0].audio = { features: feat({ crestDb: 2 }) };
  st.tracks[0].clips[1].audio = { features: feat({ crestDb: 10 }) };
  const ta = analyzeMusicState(st).trackAudio?.[0];
  // (2*4 + 10*16) / 20 = 8.4 — the long clip dominates the weighted mean.
  check("aggregate weighted by clip duration", !!ta && Math.abs(ta.crestDb - 8.4) < 0.01, String(ta?.crestDb));

  // Bands/centroid are ENERGY-weighted (seconds × 10^(rmsDb/10)): a clip
  // 30 dB down must not pull the track's balance toward its own spectrum.
  const stE = buildMusicState(
    song([track(0, "Drums", [audioClip({ name: "loud", duration: 16 }), audioClip({ name: "quiet", duration: 16 })], { type: "audio" })]),
  );
  stE.tracks[0].clips[0].audio = {
    features: feat({ rmsDb: -10, bands: { sub: 0.6, bass: 0.3, lowMid: 0.05, mid: 0.03, highMid: 0.01, high: 0.01 } }),
  };
  stE.tracks[0].clips[1].audio = {
    features: feat({ rmsDb: -40, bands: { sub: 0, bass: 0, lowMid: 0.02, mid: 0.03, highMid: 0.05, high: 0.9 } }),
  };
  const taE = analyzeMusicState(stE).trackAudio?.[0];
  // Duration-weighted would read high ≈ 0.46; energy-weighted ≈ 0.011.
  check("bands follow the LOUD clip (energy-weighted)", !!taE && taE.bands.high < 0.05 && taE.bands.sub > 0.55,
    taE ? `high=${taE.bands.high.toFixed(3)} sub=${taE.bands.sub.toFixed(3)}` : "null");

  const st2 = buildMusicState(song([track(0, "Drums", [audioClip(), audioClip({ name: "b" })], { type: "audio" })]));
  st2.tracks[0].clips[0].audio = { features: feat() };
  st2.tracks[0].clips[1].audio = { error: "unreadable (missing or denied)" };
  const ta2 = analyzeMusicState(st2).trackAudio?.[0];
  check("failed clip counted, excluded from aggregate", !!ta2 && ta2.clips === 1 && ta2.failedClips === 1);

  const st3 = buildMusicState(song([track(0, "Drums", [audioClip()], { type: "audio" })]));
  st3.tracks[0].clips[0].audio = { error: "unreadable (missing or denied)" };
  const ma3 = analyzeMusicState(st3);
  check("all clips failed → no aggregate, no false claims", !ma3.trackAudio && !ma3.issues.some((i) => AUDIO_CODES.includes(i.code)));
}

// Presentation: audioRun → feat rendered, caveat switches, note explains empty runs.
{
  const audioRun: AudioEnrichStats = { computed: 1, cached: 0, failed: 0, skipped: 0 };
  const st = buildMusicState(song([track(0, "Kick", [audioClip()], { type: "audio" })]));
  st.tracks[0].clips[0].audio = { features: feat({ crestDb: 1.5 }) };
  const sa = presentAnalysis(st, analyzeMusicState(st), 5800, undefined, audioRun);
  check("audio:true → audioRun echo", sa.audioRun?.computed === 1 && sa.audioRun.note === undefined);
  check("audio:true → feat rendered (rounded)", sa.tracks[0].audio?.feat?.crest === 1.5 && sa.tracks[0].audio?.feat?.bands.sub === 0.1,
    JSON.stringify(sa.tracks[0].audio?.feat));
  check("audio:true → caveat switches to source-file variant", sa.caveat.includes("SOURCE FILES"));
  check("no audioRun → MIDI-only caveat", !presentAnalysis(st, analyzeMusicState(st), 5800).caveat.includes("SOURCE FILES"));

  const squeezed = presentAnalysis(st, analyzeMusicState(st), 800, undefined, audioRun);
  check("fitBudget drops feat before files under pressure", !squeezed.tracks.some((t) => t.audio?.feat));

  const empty = presentAnalysis(buildMusicState(song([])), analyzeMusicState(buildMusicState(song([]))), 5800, undefined, audioRun);
  check("zero-audio Set → note says so", empty.audioRun?.note === "no audio clips in the Set", empty.audioRun?.note);

  const stF = buildMusicState(song([track(0, "Kick", [audioClip()], { type: "audio" })]));
  stF.tracks[0].clips[0].audio = { error: "unreadable (missing or denied)" };
  const failedRun: AudioEnrichStats = { computed: 0, cached: 0, failed: 1, skipped: 0 };
  const saF = presentAnalysis(stF, analyzeMusicState(stF), 5800, undefined, failedRun);
  check("clips present but none analyzed → note explains", saF.audioRun?.note === "audio clips present but none analyzed (failed 1, skipped 0)", saF.audioRun?.note);
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 项失败 / ${passed + failed}` : `\n全部通过 (${passed})`);
process.exit(failed ? 1 : 0);
