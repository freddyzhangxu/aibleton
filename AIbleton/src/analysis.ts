/**
 * analysis.ts — read-only musical analysis of a Live Set snapshot.
 *
 * Pure functions only: no imports, no SDK, no I/O. server.ts builds a plain
 * SongSnapshot from the Live SDK and passes it to analyzeSong(); everything
 * here runs on serializable data so it can be fixture-tested offline with tsx.
 *
 * Design notes:
 * - Drum tracks are excluded from the key histogram (a 4-on-floor kick at
 *   pitch 36 would otherwise dominate and bias detection toward C-ish keys).
 * - Looped clips are "virtually unrolled": material is read once from the
 *   loop window and weighted by repeats; notes are never materialized.
 * - Anything muted (note / clip / track / via-solo) is excluded from stats
 *   and reported once via MUTED_CONTENT.
 */

// ---------------------------------------------------------------------------
// Snapshot input (built by server.ts from SDK objects)
// ---------------------------------------------------------------------------

export interface SnapshotNote {
  pitch: number;
  start: number; // beats, relative to clip start
  duration: number; // beats
  velocity: number; // builder defaults to 100
  muted?: boolean;
}

export interface SnapshotClip {
  kind: "midi" | "audio";
  name: string;
  start: number | null; // arrangement position in beats; null = session clip
  duration: number; // beats
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  startMarker: number;
  muted: boolean;
  notes?: SnapshotNote[]; // midi only
  file?: string; // audio only: basename
}

export interface SnapshotTrack {
  index: number;
  name: string;
  type: "midi" | "audio";
  mute: boolean;
  mutedViaSolo: boolean;
  group?: string;
  drumPads?: number[]; // receivingNote of the first DrumRack's chains
  devices: string[]; // device names, max 6
  clips: SnapshotClip[]; // arrangement (start != null) + session (start = null)
}

export interface SongSnapshot {
  tempo: number;
  timeSig: { numerator: number; denominator: number };
  liveScale: { mode: boolean; root: number; name: string; intervals: number[] };
  cuePoints: { time: number; name: string }[];
  sceneCount: number;
  tracks: SnapshotTrack[];
}

// ---------------------------------------------------------------------------
// Analysis output
// ---------------------------------------------------------------------------

export type TrackRole =
  | "kick" | "snare" | "clap" | "hats" | "cymbal" | "tom"
  | "drums" | "percussion"
  | "bass" | "chords" | "pad" | "lead" | "arp" | "vocal" | "fx" | "unknown";

export interface KeyAnalysis {
  status: "ok" | "insufficient_material";
  best?: string; // "F# minor"
  confidence?: "high" | "medium" | "low";
  r?: number; // best Pearson correlation (2 dp)
  margin?: number; // r1 - r2
  candidates?: [string, number][]; // top-3 (may be cut to 1 by fitBudget)
}

export interface SectionInfo {
  name: string; // cue name or "bars 9-16"
  bars: [number, number]; // 1-based inclusive
  energy: "low" | "mid" | "high";
  tracks: number; // tracks with >= 1 onset in this section
  notes: number;
}

export interface TrackAnalysis {
  i: number; // same order as get_song_overview
  name: string;
  role: TrackRole;
  notes: number; // audible notes incl. loop repeats
  range?: string; // "F#1-C#2"
  dens?: number; // audible notes / bar over the track's active span
  poly?: number; // sum(duration) / single-pass span
  vel?: [number, number, number]; // min, max, avg
  ent?: number; // 0-1 rhythm entropy; omitted with < 8 onsets
  uniq?: number; // unique pitches
  clips: number;
  muted?: true;
  audio?: { clips: number; bars: number; files?: string[] };
}

export interface SongAnalysis {
  tempo: number;
  timeSig: string;
  liveScale: { mode: boolean; root: string; name: string } | null;
  key: KeyAnalysis;
  arrangement: { bars: number; beats: number } | null;
  sections: SectionInfo[];
  tracks: TrackAnalysis[];
  tracksOmitted?: number;
  session: { scenes: number; clips: number; tracks: number; notes: number };
  issues: string[];
  caveat: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Krumhansl-Kessler key profiles. */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** Ordered by specificity — first match wins. */
const ROLE_KEYWORDS: [TrackRole, RegExp][] = [
  ["kick", /\bkick|bass\s*drum|\bbd\b/i],
  ["snare", /snare|\bsd\b/i],
  ["clap", /clap/i],
  ["hats", /hats?|hihat|\bhh\b/i],
  ["cymbal", /cymbal|crash|ride|splash|china/i],
  ["tom", /\btoms?\b/i],
  ["percussion", /perc|shaker|tamb|conga|bongo|cowbell|rim/i],
  ["drums", /drums?|kit|beats?\b/i],
  ["bass", /808|\bsub|\bbass|reese/i],
  ["pad", /pads?|atmos/i],
  ["chords", /strings?|chords?|keys|piano|\bep\b|rhodes|organ|stabs?|pluck/i],
  ["lead", /leads?|melod|topline|top\s*line|solo/i],
  ["arp", /arps?/i],
  ["vocal", /vox|vocals?|choir|voice/i],
  ["fx", /\bfx\b|riser|noise|impact|sweep|uplift|downlift|texture/i],
];

const DRUM_NAME_RE =
  /kick|snare|clap|hats?|hihat|\bhh\b|cymbal|crash|ride|\btoms?\b|perc|drums?|kit|shaker|tamb|conga|bongo/i;

const CAVEAT =
  "MIDI/structure-based only: audio clips contribute filename + duration, " +
  "no loudness/timbre/pitch analysis. Loop repeats estimated virtually " +
  "(material x repeats). Track indices match get_song_overview.";

const MIN_NOTES_FOR_ISSUES = 32;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pitchName(p: number): string {
  const c = Math.max(0, Math.min(127, Math.round(p)));
  return NOTE_NAMES[c % 12] + (Math.floor(c / 12) - 1);
}

function pcName(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------------------
// Clip material / loop windows
// ---------------------------------------------------------------------------

interface Window {
  winStart: number;
  winEnd: number;
  loopLen: number;
  repeats: number;
}

function audibleWindow(clip: SnapshotClip): Window {
  const dur = Math.max(0, clip.duration || 0);
  if (dur <= 0) return { winStart: 0, winEnd: 0, loopLen: 0, repeats: 0 };
  if (clip.looping) {
    const ls = clip.loopStart ?? 0;
    const le = clip.loopEnd ?? 0;
    const loopLen = le - ls;
    if (loopLen > 1e-4) {
      return {
        winStart: ls,
        winEnd: le,
        loopLen,
        repeats: Math.max(1, dur / loopLen),
      };
    }
    // Degenerate loop markers: treat as one-shot.
    return { winStart: 0, winEnd: dur, loopLen: dur, repeats: 1 };
  }
  const sm = clip.startMarker ?? 0;
  return { winStart: sm, winEnd: sm + dur, loopLen: dur, repeats: 1 };
}

/** Notes inside the audible window, unmuted, velocity defaulted. */
function materialNotes(clip: SnapshotClip, win: Window): SnapshotNote[] {
  if (clip.kind !== "midi" || !clip.notes || win.repeats <= 0) return [];
  const out: SnapshotNote[] = [];
  for (const n of clip.notes) {
    if (n.muted) continue;
    if (n.start < win.winStart - 1e-6 || n.start >= win.winEnd - 1e-6) continue;
    out.push({ ...n, velocity: n.velocity ?? 100 });
  }
  return out;
}

interface ClipMaterial {
  clip: SnapshotClip;
  win: Window;
  material: SnapshotNote[];
}

// ---------------------------------------------------------------------------
// Track features
// ---------------------------------------------------------------------------

interface TrackFeatures {
  audibleNotes: number; // material notes x repeats
  materialCount: number; // single-pass
  pitchMin: number;
  pitchMax: number;
  uniq: number;
  sumDur: number; // single-pass
  spanSingle: number; // beats, first onset -> last offset, no repeat tiling
  spanAudible: number; // beats, incl. repeat tiling
  velMin: number;
  velMax: number;
  velAvg: number;
  onsetBeatsInBar: number[]; // single-pass onsets mapped into bar position
  sessionNotes: number;
  mutedNotes: number; // inside otherwise audible clips
}

function trackFeatures(
  track: SnapshotTrack,
  barBeats: number,
  clipMats: ClipMaterial[],
): TrackFeatures | null {
  let audibleNotes = 0;
  let materialCount = 0;
  let pitchMin = Infinity;
  let pitchMax = -Infinity;
  const uniq = new Set<number>();
  let sumDur = 0;
  let firstOnset = Infinity;
  let lastOffsetSingle = -Infinity;
  let lastOffsetAudible = -Infinity;
  let velMin = Infinity;
  let velMax = -Infinity;
  let velSum = 0;
  const onsetBeatsInBar: number[] = [];
  let sessionNotes = 0;
  let mutedNotes = 0;

  for (const cm of clipMats) {
    const { clip, win, material } = cm;
    const isSession = clip.start === null;
    const base = clip.start ?? 0;
    if (clip.kind === "midi" && clip.notes) {
      mutedNotes += clip.notes.filter(
        (n) => n.muted && n.start >= win.winStart - 1e-6 && n.start < win.winEnd - 1e-6,
      ).length;
    }
    if (isSession) {
      sessionNotes += material.length;
      continue; // session clips feed the key histogram only, not timeline stats
    }
    materialCount += material.length;
    audibleNotes += Math.round(material.length * win.repeats);
    for (const n of material) {
      const rel = n.start - win.winStart;
      const onset = base + rel;
      const offSingle = onset + n.duration;
      const offAudible = offSingle + (win.repeats - 1) * win.loopLen;
      if (onset < firstOnset) firstOnset = onset;
      if (offSingle > lastOffsetSingle) lastOffsetSingle = offSingle;
      if (offAudible > lastOffsetAudible) lastOffsetAudible = offAudible;
      if (n.pitch < pitchMin) pitchMin = n.pitch;
      if (n.pitch > pitchMax) pitchMax = n.pitch;
      uniq.add(n.pitch);
      sumDur += n.duration;
      if (n.velocity < velMin) velMin = n.velocity;
      if (n.velocity > velMax) velMax = n.velocity;
      velSum += n.velocity;
      onsetBeatsInBar.push(((onset % barBeats) + barBeats) % barBeats);
    }
  }

  if (materialCount === 0) {
    return sessionNotes > 0 || mutedNotes > 0
      ? {
          audibleNotes: 0, materialCount: 0, pitchMin: 0, pitchMax: 0, uniq: 0,
          sumDur: 0, spanSingle: 0, spanAudible: 0, velMin: 0, velMax: 0, velAvg: 0,
          onsetBeatsInBar: [], sessionNotes, mutedNotes,
        }
      : null;
  }

  return {
    audibleNotes,
    materialCount,
    pitchMin,
    pitchMax,
    uniq: uniq.size,
    sumDur,
    spanSingle: Math.max(1, lastOffsetSingle - firstOnset),
    spanAudible: Math.max(barBeats, lastOffsetAudible - firstOnset),
    velMin,
    velMax,
    velAvg: velSum / materialCount,
    onsetBeatsInBar,
    sessionNotes,
    mutedNotes,
  };
}

/** Normalized onset-position entropy on a 16th-note grid. */
function rhythmEntropy(onsetsInBar: number[], slotsPerBar: number): number | null {
  if (onsetsInBar.length < 8) return null;
  const slots = Math.max(1, Math.round(slotsPerBar));
  const counts = new Map<number, number>();
  for (const b of onsetsInBar) {
    const s = ((Math.round(b * 4) % slots) + slots) % slots;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let h = 0;
  const total = onsetsInBar.length;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  const maxH = Math.log2(slots);
  return maxH > 0 ? round2(h / maxH) : 0;
}

// ---------------------------------------------------------------------------
// Key detection
// ---------------------------------------------------------------------------

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 0 || db <= 0) return 0;
  return num / Math.sqrt(da * db);
}

interface HistogramResult {
  hist: number[];
  drumExcluded: boolean;
  totalWeight: number;
}

function pitchClassHistogram(
  perTrack: { isDrums: boolean; clipMats: ClipMaterial[] }[],
): HistogramResult {
  const build = (includeDrums: boolean): { hist: number[]; total: number } => {
    const hist = new Array(12).fill(0);
    let total = 0;
    for (const t of perTrack) {
      if (!includeDrums && t.isDrums) continue;
      for (const cm of t.clipMats) {
        if (cm.clip.muted) continue;
        const w = cm.win.repeats;
        for (const n of cm.material) {
          const weight = n.duration * w;
          hist[n.pitch % 12] += weight;
          total += weight;
        }
      }
    }
    return { hist, total };
  };
  const nonDrum = build(false);
  if (nonDrum.total > 0) return { hist: nonDrum.hist, drumExcluded: true, totalWeight: nonDrum.total };
  const all = build(true);
  return { hist: all.hist, drumExcluded: false, totalWeight: all.total };
}

interface KeyResult extends KeyAnalysis {
  root?: number; // 0-11, internal
  mode?: "major" | "minor"; // internal
}

function detectKey(hist: number[]): KeyResult {
  const uniq = hist.filter((v) => v > 1e-9).length;
  const total = hist.reduce((a, b) => a + b, 0);
  if (uniq < 4 || total < 16) return { status: "insufficient_material" };

  const scored: { root: number; mode: "major" | "minor"; r: number }[] = [];
  for (let root = 0; root < 12; root++) {
    const rotated = new Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = hist[(i + root) % 12];
    scored.push({ root, mode: "major", r: pearson(rotated, KK_MAJOR) });
    scored.push({ root, mode: "minor", r: pearson(rotated, KK_MINOR) });
  }
  scored.sort((a, b) => b.r - a.r);
  const top = scored.slice(0, 3);
  const label = (s: { root: number; mode: string }) => `${pcName(s.root)} ${s.mode}`;
  const r1 = top[0].r;
  const margin = top[0].r - top[1].r;
  const confidence: KeyAnalysis["confidence"] =
    r1 >= 0.75 && margin >= 0.08 ? "high" : r1 < 0.5 ? "low" : "medium";
  return {
    status: "ok",
    root: top[0].root,
    mode: top[0].mode,
    best: label(top[0]),
    confidence,
    r: round2(r1),
    margin: round2(margin),
    candidates: top.map((s) => [label(s), round2(s.r)] as [string, number]),
  };
}

function scalePitchSet(root: number, intervals: number[]): Set<number> {
  return new Set(intervals.map((i) => (((root + i) % 12) + 12) % 12));
}

// ---------------------------------------------------------------------------
// Role inference
// ---------------------------------------------------------------------------

function classifyDrums(track: SnapshotTrack): boolean {
  if (track.drumPads && track.drumPads.length > 0) return true;
  return DRUM_NAME_RE.test(track.name);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function inferRole(
  track: SnapshotTrack,
  feats: TrackFeatures | null,
  isDrums: boolean,
  barBeats: number,
): TrackRole {
  const scores = new Map<TrackRole, number>();
  const add = (role: TrackRole, pts: number) =>
    scores.set(role, (scores.get(role) ?? 0) + pts);

  const name = track.name ?? "";
  let nameRole: TrackRole | null = null;
  for (const [role, re] of ROLE_KEYWORDS) {
    if (re.test(name)) {
      nameRole = role;
      break;
    }
  }
  if (nameRole) {
    // An "808" track routed through a DrumRack is drums, not bass.
    if (!(nameRole === "bass" && /808/.test(name) && isDrums)) add(nameRole, 10);
  }

  if (isDrums) {
    const pads = track.drumPads ?? [];
    if (pads.length === 1 && pads[0] === 36) add("kick", 8);
    if (feats && feats.materialCount > 0 && feats.pitchMax <= 40) {
      // Notes concentrated on a single low pad.
      if (feats.uniq === 1 && feats.pitchMin === 36) add("kick", 6);
    }
    if (!nameRole) add(pads.length >= 2 ? "drums" : "percussion", 4);
    add("drums", 3);
  } else if (feats && feats.materialCount > 0) {
    const poly = feats.sumDur / feats.spanSingle;
    const dens = feats.audibleNotes / Math.max(1, feats.spanAudible / barBeats);
    if (feats.pitchMax < 48 && poly < 1.3) add("bass", 8);
    if (poly >= 1.8) {
      const durs = feats.onsetBeatsInBar.length ? featsDurationsSorted(track) : [];
      const med = median(durs);
      add(med >= 2 ? "pad" : "chords", 7);
    }
    if (dens >= 6 && feats.uniq >= 4 && poly < 1.3) add("arp", 5);
    if (feats.pitchMin >= 60 && poly < 1.3 && dens < 6) add("lead", 3);
  }

  if (scores.size === 0) return "unknown";
  const PRIORITY: TrackRole[] = [
    "kick", "snare", "clap", "hats", "cymbal", "tom", "bass",
    "pad", "chords", "lead", "arp", "vocal", "drums", "percussion", "fx",
  ];
  let best: TrackRole = "unknown";
  let bestScore = -1;
  for (const role of PRIORITY) {
    const s = scores.get(role) ?? -1;
    if (s > bestScore) {
      bestScore = s;
      best = role;
    }
  }
  return bestScore <= 0 ? "unknown" : best;
}

/** Helper for median duration inside inferRole (kept separate to avoid
 * storing every duration in TrackFeatures). */
function featsDurationsSorted(track: SnapshotTrack): number[] {
  const durs: number[] = [];
  for (const clip of track.clips) {
    if (clip.start === null || clip.muted || clip.kind !== "midi" || !clip.notes) continue;
    const win = audibleWindow(clip);
    for (const n of materialNotes(clip, win)) durs.push(n.duration);
  }
  return durs.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface RawSection {
  name: string;
  startBeat: number;
  endBeat: number;
  bars: [number, number];
}

function sectionize(
  snap: SongSnapshot,
  barBeats: number,
  arrEndBeat: number,
): RawSection[] {
  if (arrEndBeat <= 0) return [];
  const toBars = (a: number, b: number): [number, number] => [
    Math.floor(a / barBeats) + 1,
    Math.max(Math.floor(a / barBeats) + 1, Math.ceil(b / barBeats)),
  ];
  const cues = [...snap.cuePoints]
    .filter((c) => c.time >= 0 && c.time < arrEndBeat)
    .sort((a, b) => a.time - b.time);
  if (cues.length > 0) {
    const out: RawSection[] = [];
    if (cues[0].time > 0) {
      out.push({ name: "Intro", startBeat: 0, endBeat: cues[0].time, bars: toBars(0, cues[0].time) });
    }
    for (let i = 0; i < cues.length; i++) {
      const end = i + 1 < cues.length ? cues[i + 1].time : arrEndBeat;
      out.push({
        name: cues[i].name || `Section ${i + 1}`,
        startBeat: cues[i].time,
        endBeat: end,
        bars: toBars(cues[i].time, end),
      });
    }
    return out;
  }
  // No cue points: fixed-size energy blocks, <= 16 of them.
  let blockBars = 8;
  while (arrEndBeat / (blockBars * barBeats) > 16) blockBars *= 2;
  const blockBeats = blockBars * barBeats;
  const out: RawSection[] = [];
  for (let start = 0; start < arrEndBeat - 1e-6; start += blockBeats) {
    const end = Math.min(start + blockBeats, arrEndBeat);
    const bars = toBars(start, end);
    out.push({ name: `bars ${bars[0]}-${bars[1]}`, startBeat: start, endBeat: end, bars });
  }
  return out;
}

function sectionEnergy(
  sections: RawSection[],
  perTrack: { track: SnapshotTrack; clipMats: ClipMaterial[] }[],
): SectionInfo[] {
  const notes = sections.map(() => 0);
  const trackSets = sections.map(() => new Set<number>());
  for (const { track, clipMats } of perTrack) {
    if (track.mute || track.mutedViaSolo) continue;
    for (const cm of clipMats) {
      const { clip, win, material } = cm;
      if (clip.start === null || clip.muted || material.length === 0) continue;
      const tiles = Math.max(1, Math.ceil(clip.duration / Math.max(win.loopLen, 1e-6) - 1e-6));
      for (let k = 0; k < tiles; k++) {
        for (const n of material) {
          const onset = clip.start + (n.start - win.winStart) + k * win.loopLen;
          for (let s = 0; s < sections.length; s++) {
            if (onset >= sections[s].startBeat - 1e-6 && onset < sections[s].endBeat - 1e-6) {
              notes[s]++;
              trackSets[s].add(track.index);
              break;
            }
          }
        }
      }
    }
  }
  const maxNotes = Math.max(0, ...notes);
  const out: SectionInfo[] = [];
  for (let s = 0; s < sections.length; s++) {
    if (notes[s] === 0) continue;
    const ratio = maxNotes > 0 ? notes[s] / maxNotes : 0;
    out.push({
      name: sections[s].name,
      bars: sections[s].bars,
      energy: ratio < 0.34 ? "low" : ratio < 0.67 ? "mid" : "high",
      tracks: trackSets[s].size,
      notes: notes[s],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprint (SINGLE_LOOP detection)
// ---------------------------------------------------------------------------

function fingerprint(cm: ClipMaterial): string {
  const { win, material } = cm;
  const sig = material
    .map((n) => {
      const q = Math.round((n.start - win.winStart) / 0.25) * 0.25;
      return `${n.pitch}@${q.toFixed(2)}`;
    })
    .sort()
    .join(",");
  const str = `${cm.clip.duration.toFixed(2)}|${sig}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function detectIssues(ctx: {
  snap: SongSnapshot;
  key: KeyResult;
  perTrack: {
    track: SnapshotTrack;
    feats: TrackFeatures | null;
    role: TrackRole;
    clipMats: ClipMaterial[];
  }[];
  sections: SectionInfo[];
  arrangementBars: number;
  arrFingerprints: Set<string>;
  duplicateGroups: { i: number; name: string }[][];
  arrMidiClips: number;
  hasArrClips: boolean;
  sessionClipCount: number;
  totalAudible: number;
  globalPitchMin: number;
  globalPitchMax: number;
  mutedTrackNotes: number;
  mutedClipNotes: number;
  mutedNotes: number;
}): string[] {
  const issues: string[] = [];
  const { snap, key } = ctx;

  if (ctx.totalAudible === 0 && ctx.sessionClipCount === 0) {
    const hasAudio = snap.tracks.some((t) => t.clips.some((c) => c.kind === "audio"));
    if (!hasAudio) {
      issues.push("EMPTY_SET: no MIDI notes or audio clips in the Set");
      return issues;
    }
  }
  if (!ctx.hasArrClips && ctx.sessionClipCount > 0) {
    issues.push(
      `NO_ARRANGEMENT: arrangement is empty, ${ctx.sessionClipCount} session clip(s) only — key/stats are session-based`,
    );
  }
  if (
    ctx.arrangementBars > 32 &&
    ctx.arrMidiClips >= 2 &&
    ctx.arrFingerprints.size <= 2
  ) {
    issues.push(
      `SINGLE_LOOP: ${Math.round(ctx.arrangementBars)} bars but only ${ctx.arrFingerprints.size} unique clip(s) — arrangement is one loop repeated`,
    );
  }
  if (ctx.sections.length >= 4) {
    const vals = ctx.sections.map((s) => s.notes);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean > 0) {
      const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
      const cv = sd / mean;
      if (cv < 0.15) {
        issues.push(
          `LOW_CONTRAST: energy nearly constant across ${ctx.sections.length} sections (cv=${round2(cv)}) — arrangement may lack build/drop contrast`,
        );
      }
    }
  }
  for (const group of ctx.duplicateGroups) {
    const label = group.map((t) => `${t.i} "${t.name}"`).join(" and ");
    issues.push(
      `DUPLICATE_CONTENT: tracks ${label} are note-for-note identical (pitch/timing) — mute or delete one if not an intentional layer`,
    );
  }
  if (snap.liveScale.mode && key.status === "ok" && key.confidence !== "low" && key.root !== undefined) {
    const liveRoot = ((snap.liveScale.root % 12) + 12) % 12;
    const diff = (((key.root - liveRoot) % 12) + 12) % 12;
    if (diff !== 0 && diff !== 3 && diff !== 9) {
      issues.push(
        `KEY_MISMATCH: Live scale is ${pcName(liveRoot)} ${snap.liveScale.name} but detected key is ${key.best} (r=${key.r})`,
      );
    }
  }
  // OFF_KEY
  let scaleSet: Set<number> | null = null;
  let scaleLabel = "";
  if (snap.liveScale.mode && snap.liveScale.intervals.length > 0) {
    scaleSet = scalePitchSet(snap.liveScale.root, snap.liveScale.intervals);
    scaleLabel = `Live scale ${pcName(snap.liveScale.root)} ${snap.liveScale.name}`;
  } else if (key.status === "ok" && key.root !== undefined && key.mode) {
    scaleSet = scalePitchSet(key.root, key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS);
    scaleLabel = `detected key ${key.best}`;
  }
  if (scaleSet) {
    let inW = 0;
    let outW = 0;
    for (const pt of ctx.perTrack) {
      if (pt.track.mute || pt.track.mutedViaSolo) continue;
      const drums = classifyDrums(pt.track);
      if (drums) continue;
      for (const cm of pt.clipMats) {
        if (cm.clip.muted) continue;
        for (const n of cm.material) {
          const w = n.duration * cm.win.repeats;
          if (scaleSet.has(n.pitch % 12)) inW += w;
          else outW += w;
        }
      }
    }
    const total = inW + outW;
    if (total >= 16) {
      const pct = outW / total;
      if (pct > 0.15) {
        issues.push(
          `OFF_KEY: ${Math.round(pct * 100)}% of note duration is outside ${scaleLabel} — check for wrong notes (or intentional chromaticism)`,
        );
      }
    }
  }
  if (ctx.totalAudible >= MIN_NOTES_FOR_ISSUES) {
    if (ctx.globalPitchMin >= 48) {
      issues.push(
        `NO_LOW_END: lowest note is ${pitchName(ctx.globalPitchMin)} across ${ctx.totalAudible} notes — nothing below C3`,
      );
    }
    if (ctx.globalPitchMax < 72) {
      issues.push(
        `NO_HIGH_END: highest note is ${pitchName(ctx.globalPitchMax)} across ${ctx.totalAudible} notes — nothing at/above C5`,
      );
    }
  }
  for (const pt of ctx.perTrack) {
    const f = pt.feats;
    if (!f || f.materialCount < MIN_NOTES_FOR_ISSUES) continue;
    if (f.velMax - f.velMin <= 6) {
      issues.push(
        `FLAT_DYNAMICS: "${pt.track.name}" velocity range ${Math.round(f.velMax - f.velMin)} across ${f.materialCount} notes — sounds mechanical`,
      );
    }
    if (pt.role === "bass" && f.uniq <= 2) {
      issues.push(
        `MONOTONE_BASS: "${pt.track.name}" plays only ${f.uniq} pitch(es) across ${f.materialCount} notes`,
      );
    }
  }
  const mutedParts: string[] = [];
  if (ctx.mutedTrackNotes > 0) mutedParts.push(`${ctx.mutedTrackNotes} notes on muted tracks`);
  if (ctx.mutedClipNotes > 0) mutedParts.push(`${ctx.mutedClipNotes} notes in muted clips`);
  if (ctx.mutedNotes > 0) mutedParts.push(`${ctx.mutedNotes} muted notes`);
  if (mutedParts.length > 0) {
    issues.push(`MUTED_CONTENT: ${mutedParts.join(", ")} — excluded from all stats`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Budget fitting (callTool hard-truncates at 6000 chars)
// ---------------------------------------------------------------------------

function fitBudget(analysis: SongAnalysis, budget = 5800): SongAnalysis {
  const size = () => JSON.stringify(analysis).length;
  if (size() <= budget) return analysis;
  for (const t of analysis.tracks) {
    if (t.audio?.files) delete t.audio.files;
  }
  if (size() <= budget) return analysis;
  if (analysis.tracks.length > 12) {
    analysis.tracksOmitted = (analysis.tracksOmitted ?? 0) + analysis.tracks.length - 12;
    analysis.tracks = analysis.tracks.slice(0, 12);
  }
  if (size() <= budget) return analysis;
  if (analysis.key.candidates && analysis.key.candidates.length > 1) {
    analysis.key.candidates = analysis.key.candidates.slice(0, 1);
  }
  if (size() <= budget) return analysis;
  if (analysis.sections.length > 12) {
    analysis.sections = [...analysis.sections.slice(0, 6), ...analysis.sections.slice(-6)];
  }
  return analysis;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function analyzeSong(input: SongSnapshot): SongAnalysis {
  // Normalize: smoke tests and the fake-context harness pass partial objects.
  const snap: SongSnapshot = {
    tempo: input.tempo ?? 120,
    timeSig: input.timeSig ?? { numerator: 4, denominator: 4 },
    liveScale: input.liveScale ?? { mode: false, root: 0, name: "", intervals: [] },
    cuePoints: input.cuePoints ?? [],
    sceneCount: input.sceneCount ?? 0,
    tracks: input.tracks ?? [],
  };
  const num = snap.timeSig.numerator || 4;
  const den = snap.timeSig.denominator || 4;
  const barBeats = (num * 4) / den;
  const tracks = snap.tracks;

  // Per-track materials + features (order: drums pre-classify -> histogram ->
  // key -> roles, because drums must stay out of the key histogram).
  const perTrack = tracks.map((track) => {
    const trackMuted = track.mute || track.mutedViaSolo;
    const clipMats: ClipMaterial[] = track.clips.map((clip) => {
      const win = audibleWindow(clip);
      return { clip, win, material: clip.muted || trackMuted ? [] : materialNotes(clip, win) };
    });
    const feats = trackMuted ? null : trackFeatures(track, barBeats, clipMats);
    return { track, isDrums: classifyDrums(track), feats, clipMats };
  });

  const { hist } = pitchClassHistogram(perTrack);
  const key = detectKey(hist);

  const roles = perTrack.map((pt) => inferRole(pt.track, pt.feats, pt.isDrums, barBeats));

  // Arrangement extent (any clip kind counts, muted or not — it still occupies time).
  let arrEnd = 0;
  let hasArrClips = false;
  let arrMidiClips = 0;
  for (const pt of perTrack) {
    for (const cm of pt.clipMats) {
      if (cm.clip.start === null) continue;
      hasArrClips = true;
      if (cm.clip.kind === "midi") arrMidiClips++;
      const end = cm.clip.start + Math.max(0, cm.clip.duration);
      if (end > arrEnd) arrEnd = end;
    }
  }
  const arrangementBars = arrEnd > 0 ? arrEnd / barBeats : 0;

  const rawSections = sectionize(snap, barBeats, arrEnd);
  const sections = sectionEnergy(rawSections, perTrack);

  // Fingerprints over audible arrangement MIDI clips (muted excluded), plus
  // per-track content signatures for cross-track duplicate detection.
  const arrFingerprints = new Set<string>();
  const trackSigs = new Map<string, { i: number; name: string }[]>();
  for (const pt of perTrack) {
    if (pt.track.mute || pt.track.mutedViaSolo) continue;
    const fps: string[] = [];
    for (const cm of pt.clipMats) {
      if (cm.clip.start === null || cm.clip.muted || cm.clip.kind !== "midi") continue;
      if (cm.material.length === 0) continue;
      const fp = fingerprint(cm);
      arrFingerprints.add(fp);
      fps.push(fp);
    }
    if (fps.length > 0) {
      const sig = fps.sort().join("+");
      const group = trackSigs.get(sig) ?? [];
      group.push({ i: pt.track.index, name: pt.track.name });
      trackSigs.set(sig, group);
    }
  }
  const duplicateGroups = [...trackSigs.values()].filter((g) => g.length > 1);

  // Session summary + global stats.
  let sessionClipCount = 0;
  let sessionNotes = 0;
  const sessionTracks = new Set<number>();
  let totalAudible = 0;
  let globalPitchMin = Infinity;
  let globalPitchMax = -Infinity;
  let mutedTrackNotes = 0;
  let mutedClipNotes = 0;
  let mutedNoteCount = 0;
  for (const pt of perTrack) {
    for (const cm of pt.clipMats) {
      if (cm.clip.start === null && !cm.clip.muted && cm.clip.kind === "midi") {
        sessionClipCount++;
        sessionNotes += cm.material.length;
        if (cm.material.length > 0) sessionTracks.add(pt.track.index);
      }
    }
    if (pt.track.mute || pt.track.mutedViaSolo) {
      for (const cm of pt.clipMats) {
        if (cm.clip.kind === "midi" && cm.clip.notes) {
          mutedTrackNotes += cm.clip.notes.filter((n) => !n.muted).length;
        }
      }
      continue;
    }
    if (pt.feats) {
      totalAudible += pt.feats.audibleNotes;
      if (pt.feats.materialCount > 0) {
        if (pt.feats.pitchMin < globalPitchMin) globalPitchMin = pt.feats.pitchMin;
        if (pt.feats.pitchMax > globalPitchMax) globalPitchMax = pt.feats.pitchMax;
      }
      mutedNoteCount += pt.feats.mutedNotes;
    }
    for (const cm of pt.clipMats) {
      if (cm.clip.muted && cm.clip.kind === "midi" && cm.clip.notes) {
        mutedClipNotes += cm.clip.notes.filter((n) => !n.muted).length;
      }
    }
  }

  const issues = detectIssues({
    snap,
    key,
    perTrack: perTrack.map((pt, i) => ({
      track: pt.track,
      feats: pt.feats,
      role: roles[i],
      clipMats: pt.clipMats,
    })),
    sections,
    arrangementBars,
    arrFingerprints,
    duplicateGroups,
    arrMidiClips,
    hasArrClips,
    sessionClipCount,
    totalAudible,
    globalPitchMin: globalPitchMin === Infinity ? 127 : globalPitchMin,
    globalPitchMax: globalPitchMax === -Infinity ? 0 : globalPitchMax,
    mutedTrackNotes,
    mutedClipNotes,
    mutedNotes: mutedNoteCount,
  });

  const trackAnalyses: TrackAnalysis[] = perTrack.map((pt, i) => {
    const { track, feats } = pt;
    const arrClipCount = track.clips.filter((c) => c.start !== null).length;
    const base: TrackAnalysis = {
      i: track.index,
      name: track.name,
      role: roles[i],
      notes: feats?.audibleNotes ?? 0,
      clips: arrClipCount,
    };
    if (track.mute || track.mutedViaSolo) base.muted = true;
    const audioClips = track.clips.filter((c) => c.kind === "audio" && c.start !== null);
    if (feats && feats.materialCount > 0) {
      base.range = `${pitchName(feats.pitchMin)}-${pitchName(feats.pitchMax)}`;
      base.dens = round1(feats.audibleNotes / Math.max(1, feats.spanAudible / barBeats));
      base.poly = round2(feats.sumDur / feats.spanSingle);
      base.vel = [Math.round(feats.velMin), Math.round(feats.velMax), Math.round(feats.velAvg)];
      const ent = rhythmEntropy(feats.onsetBeatsInBar, barBeats * 4);
      if (ent !== null) base.ent = ent;
      base.uniq = feats.uniq;
    } else if (audioClips.length > 0) {
      base.audio = {
        clips: audioClips.length,
        bars: round1(audioClips.reduce((a, c) => a + Math.max(0, c.duration), 0) / barBeats),
        files: audioClips.map((c) => c.file ?? c.name).filter(Boolean).slice(0, 4),
      };
    }
    return base;
  });

  const analysis: SongAnalysis = {
    tempo: snap.tempo ?? 120,
    timeSig: `${num}/${den}`,
    liveScale: snap.liveScale?.mode
      ? { mode: true, root: pcName(snap.liveScale.root), name: snap.liveScale.name }
      : null,
    key: {
      status: key.status,
      best: key.best,
      confidence: key.confidence,
      r: key.r,
      margin: key.margin,
      candidates: key.candidates,
    },
    arrangement: arrEnd > 0 ? { bars: round1(arrangementBars), beats: round1(arrEnd) } : null,
    sections,
    tracks: trackAnalyses,
    session: {
      scenes: snap.sceneCount ?? 0,
      clips: sessionClipCount,
      tracks: sessionTracks.size,
      notes: sessionNotes,
    },
    issues,
    caveat: CAVEAT,
  };
  return fitBudget(analysis);
}
