/**
 * Fixture-based smoke test for src/analysis/select.ts (analyze_song's focus
 * parameter — the Context Selector).
 * Run: npx tsx scripts/test-context.ts
 *
 * All fixtures are plain SongSnapshot objects — no Live, no SDK.
 */
import { analyzeSong } from "../src/analysis/index.js";
import type {
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
  SongSnapshot,
} from "../src/musicstate/types.js";

// ---------------------------------------------------------------------------
// Builders (same pattern as test-analysis.ts)
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
    tempo: opt.tempo ?? 124,
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
// Main fixture: 5 tracks over a Verse (bars 1-8) / Drop (bars 9-16) split.
// Bass plays 32 one-pitch notes in the Verse only → MONOTONE_BASS, and its
// silence in the Drop is what sections[].focusTracks must show.
// ---------------------------------------------------------------------------

// Verse-only monotone bass: 8 bars x 4 notes of A1, velocity varied so no
// FLAT_DYNAMICS.
const bassNotes = repBars(
  [n(33, 0, 0.5, 92), n(33, 1, 0.5, 108), n(33, 2, 0.5, 96), n(33, 3, 0.5, 112)],
  8,
);
const kickNotes = repBars([n(36, 0, 0.25, 118), n(36, 1, 0.25, 100), n(36, 2, 0.25, 118), n(36, 3, 0.25, 100)], 16);
const hatNotes = repBars(
  [n(42, 0, 0.25, 70), n(42, 0.5, 0.25, 96), n(44, 1, 0.25, 82), n(42, 1.5, 0.25, 104), n(42, 2, 0.25, 76), n(42, 2.5, 0.25, 98), n(44, 3, 0.25, 88), n(46, 3.5, 0.25, 108)],
  16,
);
// Chords live in the Drop only — the mirror image of the bass.
const chordNotes: SnapshotNote[] = [];
for (let b = 0; b < 8; b++) {
  chordNotes.push(
    n(57, b * 4, 3, 84), // A3
    n(60, b * 4, 3, 92), // C4
    n(64, b * 4, 3, 78), // E4
  );
}
const vocalNotes = repBars(
  [n(69, 0, 1, 88), n(72, 1.5, 0.5, 96), n(76, 2, 1, 82), n(74, 3, 1, 100)],
  4,
);

const main = song(
  [
    track(0, "Kick", [midiClip(kickNotes, { start: 0, duration: 64 })]),
    track(1, "Bass", [midiClip(bassNotes, { start: 0, duration: 32 })]),
    track(2, "Chords", [midiClip(chordNotes, { start: 32, duration: 32 })]),
    track(3, "Vocal", [midiClip(vocalNotes, { start: 32, duration: 16 })]),
    track(4, "Hats", [midiClip(hatNotes, { start: 0, duration: 64 })]),
  ],
  { cuePoints: [{ time: 0, name: "Verse" }, { time: 32, name: "Drop" }] },
);

// ---------------------------------------------------------------------------
// 1. No focus — unchanged full read (regression)
// ---------------------------------------------------------------------------
console.log("== no focus: full read unchanged ==");
const full = analyzeSong(main);
check("no focus field", full.focus === undefined);
check("all tracks keep full stats", full.tracks.every((t) => t.dens !== undefined || (t.audio?.clips ?? 0) > 0 || t.muted));
check("all clips present", full.clips.length === 5);
check("no focusTracks on sections", full.sections.every((s) => s.focusTracks === undefined));

// ---------------------------------------------------------------------------
// 2. focus: "bass" — role match, projection, section activity, issue order
// ---------------------------------------------------------------------------
console.log("== focus: bass ==");
const bass = analyzeSong(main, 5800, "bass");
const bassRow = bass.tracks.find((t) => t.name === "Bass")!;
const kickRow = bass.tracks.find((t) => t.name === "Kick")!;
check("focus echo matched role:bass", bass.focus?.matched.includes("role:bass") === true, JSON.stringify(bass.focus));
check("no unmatched flag", bass.focus?.unmatched === undefined);
check("bass keeps full stats", bassRow.dens !== undefined && bassRow.uniq === 1 && bassRow.range === "A1-A1");
check("other tracks collapse to one-liners", kickRow.dens === undefined && kickRow.range === undefined && kickRow.notes > 0 && kickRow.role === "kick");
check("clips keep only bass entries", bass.clips.length === 1 && bass.clips.every((c) => c.t === 1));
check("clipsOmitted counts the rest", bass.clipsOmitted === 4, `got ${bass.clipsOmitted}`);
const verse = bass.sections.find((s) => s.name === "Verse")!;
const drop = bass.sections.find((s) => s.name === "Drop")!;
check("Verse has bass active", JSON.stringify(verse.focusTracks) === "[1]", JSON.stringify(verse.focusTracks));
check("Drop shows bass silent", JSON.stringify(drop.focusTracks) === "[]", JSON.stringify(drop.focusTracks));
check("MONOTONE_BASS sorts first", bass.issues[0]?.startsWith("MONOTONE_BASS:") === true, bass.issues[0]);

// ---------------------------------------------------------------------------
// 3. focus: "Bass" (track name, odd casing)
// ---------------------------------------------------------------------------
console.log("== focus: Bass (name match) ==");
const byName = analyzeSong(main, 5800, "Bass");
check("matched tag track:Bass", byName.focus?.matched.includes("track:Bass") === true, JSON.stringify(byName.focus));
check("bass row full via name match", byName.tracks.find((t) => t.name === "Bass")!.dens !== undefined);

// ---------------------------------------------------------------------------
// 4. focus: "drums" — generic drum word widens to every isDrums track
// ---------------------------------------------------------------------------
console.log("== focus: drums ==");
const drums = analyzeSong(main, 5800, "drums");
const drumFull = drums.tracks.filter((t) => t.dens !== undefined).map((t) => t.name);
check("Kick + Hats both full rows", JSON.stringify(drumFull.sort()) === JSON.stringify(["Hats", "Kick"]), drumFull.join(","));
check("Bass collapsed under drums focus", drums.tracks.find((t) => t.name === "Bass")!.dens === undefined);

// ---------------------------------------------------------------------------
// 5. focus that matches nothing — full read + unmatched echo
// ---------------------------------------------------------------------------
console.log("== focus: zzzz (unmatched) ==");
const miss = analyzeSong(main, 5800, "zzzz");
check("unmatched flagged", miss.focus?.unmatched === true);
check("raw echoed", miss.focus?.raw === "zzzz");
check("falls back to full stats", miss.tracks.every((t) => t.dens !== undefined || t.muted));
check("all clips still present", miss.clips.length === 5);

// ---------------------------------------------------------------------------
// 6. focus: issue code — named issue's tracks join the selection
// ---------------------------------------------------------------------------
console.log("== focus: monotone bass (issue code) ==");
const byIssue = analyzeSong(main, 5800, "monotone bass");
check("matched tag issue:MONOTONE_BASS", byIssue.focus?.matched.includes("issue:MONOTONE_BASS") === true, JSON.stringify(byIssue.focus));
check("issue's bass track selected", byIssue.tracks.find((t) => t.name === "Bass")!.dens !== undefined);
check("named issue first", byIssue.issues[0]?.startsWith("MONOTONE_BASS:") === true);

// ---------------------------------------------------------------------------
// 7. focus: "Drop" — section-only match stays echo-only (no projection)
// ---------------------------------------------------------------------------
console.log("== focus: Drop (section-only) ==");
const bySection = analyzeSong(main, 5800, "Drop");
check("matched tag section:Drop", bySection.focus?.matched.includes("section:Drop") === true, JSON.stringify(bySection.focus));
check("no unmatched flag", bySection.focus?.unmatched === undefined);
check("tracks stay full (no projection)", bySection.tracks.every((t) => t.dens !== undefined || t.muted));
check("no focusTracks without selected tracks", bySection.sections.every((s) => s.focusTracks === undefined));

// ---------------------------------------------------------------------------
// 8. focus: "chords" — Drop-only track shows the inverse section pattern
// ---------------------------------------------------------------------------
console.log("== focus: chords ==");
const chords = analyzeSong(main, 5800, "chords");
check("Verse shows chords silent", JSON.stringify(chords.sections.find((s) => s.name === "Verse")!.focusTracks) === "[]");
check("Drop has chords active", JSON.stringify(chords.sections.find((s) => s.name === "Drop")!.focusTracks) === "[2]");

// ---------------------------------------------------------------------------
// 9. 32-track stress: focused read stays small, full read gets cut
// ---------------------------------------------------------------------------
console.log("== 32-track stress ==");
const manyTracks: SnapshotTrack[] = [];
for (let i = 0; i < 32; i++) {
  // Every track gets distinct pitches — DUPLICATE_CONTENT merging its tracks
  // into the selection is by design, so this fixture must not trigger it.
  const perBar = [
    n(48 + i, 0, 0.5, 80 + (i % 40)),
    n(52 + i, 1, 0.5, 90),
    n(55 + i, 2, 0.5, 100),
    n(59 + i, 3, 0.5, 85),
  ];
  const clips = [0, 16].map((startBar) =>
    midiClip(repBars(perBar, 4), { start: startBar * 4, duration: 16, name: `clip${i}-${startBar}` }),
  );
  manyTracks.push(track(i, i === 7 ? "Bass" : `Track ${i}`, clips));
}
const big = song(manyTracks);
const bigFull = analyzeSong(big);
const bigFocus = analyzeSong(big, 5800, "bass");
const fullLen = JSON.stringify(bigFull).length;
const focusLen = JSON.stringify(bigFocus).length;
check("focused read within budget", focusLen <= 5800, `${focusLen} chars`);
check("full read had to drop tracks", (bigFull.tracksOmitted ?? 0) >= 20, `tracksOmitted=${bigFull.tracksOmitted}`);
check("focused read keeps more with fewer chars", focusLen < fullLen && bigFocus.tracks.length === 32, `${focusLen} chars / ${bigFocus.tracks.length} tracks vs ${fullLen} chars / ${bigFull.tracks.length} tracks`);
check("exactly one full row under focus", bigFocus.tracks.filter((t) => t.dens !== undefined).length === 1);
check("all 32 tracks still addressable", bigFocus.tracks.length === 32);
check("focused clips only from the bass track", bigFocus.clips.length === 2 && bigFocus.clips.every((c) => c.t === 7));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
