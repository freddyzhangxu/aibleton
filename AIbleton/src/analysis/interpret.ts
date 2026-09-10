/**
 * analysis/interpret.ts — MusicState -> MusicAnalysis: what the Set means.
 *
 * Pure interpretation, no presentation: numbers stay unrounded (rounding for
 * model-bound JSON lives in present.ts), issues come out as structured
 * MusicIssue[] (stringified by present.ts), and there is no budget cut — the
 * goal layer judges against this output directly.
 *
 * Design notes (carried over from the fused analysis.ts):
 * - Drum tracks are excluded from the key histogram (a 4-on-floor kick at
 *   pitch 36 would otherwise dominate and bias detection toward C-ish keys).
 * - Looped clips are "virtually unrolled": material is read once from the
 *   loop window and weighted by repeats; notes are never materialized.
 * - Anything muted (note / clip / track / via-solo) is excluded from stats
 *   and reported once via MUTED_CONTENT.
 */

import { audibleWindow, materialNotes } from "../musicstate/builder.js";
import type { AudioFeatures } from "../dsp.js";
import type {
  ClipWindow,
  MusicState,
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
  SongSnapshot,
  TrackMeasurements,
  TrackState,
} from "../musicstate/types.js";
import type {
  KeyAnalysis,
  MusicAnalysis,
  MusicIssue,
  OffKeyMeasure,
  SectionAnalysis,
  TrackAudioAnalysis,
  TrackRole,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Krumhansl-Kessler key profiles. */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** Off-scale duration share above which the OFF_KEY issue fires. Exported:
 * the goal layer's in_key criterion judges against the same threshold. */
export const OFF_KEY_THRESHOLD = 0.15;

/** Minimum weighted note duration before an off-key ratio is meaningful. */
const OFF_KEY_MIN_MATERIAL = 16;

/** Ordered by specificity — first match wins. Exported for select.ts, which
 * reuses the same vocabulary to resolve focus strings to roles. */
export const ROLE_KEYWORDS: [TrackRole, RegExp][] = [
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

const MIN_NOTES_FOR_ISSUES = 32;

// ---------------------------------------------------------------------------
// Small helpers (message formatting — data stays unrounded)
// ---------------------------------------------------------------------------

function pitchName(p: number): string {
  const c = Math.max(0, Math.min(127, Math.round(p)));
  return NOTE_NAMES[c % 12] + (Math.floor(c / 12) - 1);
}

/** Exported for the goal layer (evaluate.ts) — Live's scale root displays
 * through the same table everywhere. */
export function pcName(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Clip material (windows + notes come from the facts layer)
// ---------------------------------------------------------------------------

interface ClipMaterial {
  clip: SnapshotClip;
  win: ClipWindow;
  material: SnapshotNote[];
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

/** r/margin/candidates stay raw — present.ts rounds for model-bound JSON. */
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
    r: r1,
    margin,
    candidates: top.map((s) => [label(s), s.r] as [string, number]),
  };
}

function scalePitchSet(root: number, intervals: number[]): Set<number> {
  return new Set(intervals.map((i) => (((root + i) % 12) + 12) % 12));
}

/**
 * The off-key measurement, extracted so the OFF_KEY issue and the goal
 * layer's in_key/off_key_lte criteria can never disagree about the number.
 * Governing scale: Live's declared scale when Scale Mode is on (user-set
 * ground truth), else the detected major/minor key. Drums and muted content
 * are excluded. Returns null when no scale is usable or weighted material is
 * below OFF_KEY_MIN_MATERIAL — the caller treats null as UNKNOWABLE.
 */
export function measureOffKey(
  snap: SongSnapshot,
  key: KeyResult,
  perTrack: { track: SnapshotTrack; clipMats: ClipMaterial[] }[],
): OffKeyMeasure | null {
  let scaleSet: Set<number> | null = null;
  let scaleLabel = "";
  let scaleSource: OffKeyMeasure["scaleSource"] = "detected";
  if (snap.liveScale.mode && snap.liveScale.intervals.length > 0) {
    scaleSet = scalePitchSet(snap.liveScale.root, snap.liveScale.intervals);
    scaleLabel = `Live scale ${pcName(snap.liveScale.root)} ${snap.liveScale.name}`;
    scaleSource = "live";
  } else if (key.status === "ok" && key.root !== undefined && key.mode) {
    scaleSet = scalePitchSet(key.root, key.mode === "major" ? MAJOR_STEPS : MINOR_STEPS);
    scaleLabel = `detected key ${key.best}`;
  }
  if (!scaleSet) return null;

  let inW = 0;
  let outW = 0;
  for (const pt of perTrack) {
    if (pt.track.mute || pt.track.mutedViaSolo) continue;
    if (classifyDrums(pt.track)) continue;
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
  if (total < OFF_KEY_MIN_MATERIAL) return null;
  return { ratio: outW / total, scaleLabel, scaleSource };
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
  feats: TrackMeasurements | null,
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
 * storing every duration in TrackMeasurements). */
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

/** Exported for the features layer (music/features/section.ts) so section
 * boundaries have a single producer — features never re-sectionizes. */
export interface RawSection {
  name: string;
  startBeat: number;
  endBeat: number;
  bars: [number, number];
}

export function sectionize(
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
): SectionAnalysis[] {
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
  const out: SectionAnalysis[] = [];
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
// Audio feature aggregation (ClipState.audio -> per-track TrackAudioAnalysis)
// ---------------------------------------------------------------------------

/**
 * Aggregate one track's analyzed audio clips into a single measurement.
 * Eligible clips: audible arrangement clips with features — the same
 * predicate audiofiles.enrichMusicStateWithAudio fills and present.ts's
 * audio block renders, so a computed feature always aggregates and an
 * aggregated feature is always audible.
 *
 * Two weightings, by what the quantity means:
 * - bands + spectralCentroidHz are ENERGY-weighted (seconds × 10^(rmsDb/10))
 *   — that is exactly how spectra combine, so a whisper-quiet clip can't
 *   skew the balance verdict of a loud one.
 * - crest/rms/loudness/dynamicRange/transients are DURATION-weighted — they
 *   don't combine linearly over energy, and the dB-domain mean is the
 *   documented approximation.
 * Features describe clip SOURCE FILES — pre-warp, pre-gain, pre-device —
 * not the audible result.
 */
export function aggregateTrackAudio(ts: TrackState, secPerBeat: number): TrackAudioAnalysis | null {
  let failedClips = 0;
  const contributors: { f: AudioFeatures; wd: number; we: number }[] = [];
  for (const cs of ts.clips) {
    const c = cs.clip;
    if (c.kind !== "audio" || c.start === null || c.muted || !cs.audio) continue;
    if (cs.audio.error) {
      failedClips++;
      continue;
    }
    if (!cs.audio.features) continue;
    const wd = Math.max(0, c.duration) * secPerBeat;
    contributors.push({ f: cs.audio.features, wd, we: wd * 10 ** (cs.audio.features.rmsDb / 10) });
  }
  if (contributors.length === 0) return null;

  let totalWd = 0;
  let totalWe = 0;
  for (const c of contributors) {
    totalWd += c.wd;
    totalWe += c.we;
  }
  if (totalWd <= 0) totalWd = contributors.length; // zero-length clips: unweighted mean

  const dmean = (get: (f: AudioFeatures) => number): number =>
    contributors.reduce((a, c) => a + get(c.f) * c.wd, 0) / totalWd;
  const dmeanOpt = (get: (f: AudioFeatures) => number | undefined): number | undefined => {
    let sum = 0;
    let w = 0;
    for (const c of contributors) {
      const v = get(c.f);
      if (v !== undefined) {
        sum += v * c.wd;
        w += c.wd;
      }
    }
    return w > 0 ? sum / w : undefined;
  };
  // All-silent contributors (rmsDb at the −100 floor) carry ≈0 energy —
  // if every clip is silent the bands are meaningless anyway: fall back to
  // duration weighting so the numbers stay finite.
  const ew = totalWe > 1e-9 ? totalWe : totalWd;
  const emean = (get: (f: AudioFeatures) => number): number =>
    contributors.reduce((a, c) => a + get(c.f) * (totalWe > 1e-9 ? c.we : c.wd), 0) / ew;

  const dynamicRangeDb = dmeanOpt((f) => f.dynamicRangeDb);
  const transientDensity = dmeanOpt((f) => f.transientDensity);
  return {
    clips: contributors.length,
    failedClips,
    durationSec: contributors.reduce((a, c) => a + c.wd, 0),
    rmsDb: dmean((f) => f.rmsDb),
    crestDb: dmean((f) => f.crestDb),
    loudnessDb: dmean((f) => f.loudnessDb),
    ...(dynamicRangeDb !== undefined ? { dynamicRangeDb } : {}),
    spectralCentroidHz: emean((f) => f.spectralCentroidHz),
    bands: {
      sub: emean((f) => f.bands.sub),
      bass: emean((f) => f.bands.bass),
      lowMid: emean((f) => f.bands.lowMid),
      mid: emean((f) => f.bands.mid),
      highMid: emean((f) => f.bands.highMid),
      high: emean((f) => f.bands.high),
    },
    ...(transientDensity !== undefined ? { transientDensity } : {}),
    ...(contributors.some((c) => c.f.partial) ? { partial: true as const } : {}),
  };
}

/** Suffix every audio-derived issue message carries: features describe the
 * clip source files, not what Live plays through the device chain. */
const AUDIO_CAVEAT = "(from clip source files — warp/gain/devices not reflected)";

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function detectIssues(ctx: {
  snap: SongSnapshot;
  key: KeyResult;
  /** Measured once in analyzeMusicState — null = unknowable, never zero. */
  offKey: OffKeyMeasure | null;
  perTrack: {
    track: SnapshotTrack;
    feats: TrackMeasurements | null;
    role: TrackRole;
    clipMats: ClipMaterial[];
  }[];
  sections: SectionAnalysis[];
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
  /** Parallel to perTrack/state.tracks; null entries = no analyzed audio. */
  trackAudio: (TrackAudioAnalysis | null)[];
}): MusicIssue[] {
  const issues: MusicIssue[] = [];
  const { snap, key } = ctx;

  if (ctx.totalAudible === 0 && ctx.sessionClipCount === 0) {
    const hasAudio = snap.tracks.some((t) => t.clips.some((c) => c.kind === "audio"));
    if (!hasAudio) {
      issues.push({ code: "EMPTY_SET", message: "no MIDI notes or audio clips in the Set" });
      return issues;
    }
  }
  if (!ctx.hasArrClips && ctx.sessionClipCount > 0) {
    issues.push({
      code: "NO_ARRANGEMENT",
      message: `arrangement is empty, ${ctx.sessionClipCount} session clip(s) only — key/stats are session-based`,
    });
  }
  if (
    ctx.arrangementBars > 32 &&
    ctx.arrMidiClips >= 2 &&
    ctx.arrFingerprints.size <= 2
  ) {
    issues.push({
      code: "SINGLE_LOOP",
      message: `${Math.round(ctx.arrangementBars)} bars but only ${ctx.arrFingerprints.size} unique clip(s) — arrangement is one loop repeated`,
    });
  }
  if (ctx.sections.length >= 4) {
    const vals = ctx.sections.map((s) => s.notes);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean > 0) {
      const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
      const cv = sd / mean;
      if (cv < 0.15) {
        issues.push({
          code: "LOW_CONTRAST",
          message: `energy nearly constant across ${ctx.sections.length} sections (cv=${round2(cv)}) — arrangement may lack build/drop contrast`,
        });
      }
    }
  }
  for (const group of ctx.duplicateGroups) {
    const label = group.map((t) => `${t.i} "${t.name}"`).join(" and ");
    issues.push({
      code: "DUPLICATE_CONTENT",
      message: `tracks ${label} are note-for-note identical (pitch/timing) — mute or delete one if not an intentional layer`,
      tracks: group.map((t) => t.i),
    });
  }
  if (snap.liveScale.mode && key.status === "ok" && key.confidence !== "low" && key.root !== undefined) {
    const liveRoot = ((snap.liveScale.root % 12) + 12) % 12;
    const diff = (((key.root - liveRoot) % 12) + 12) % 12;
    if (diff !== 0 && diff !== 3 && diff !== 9) {
      issues.push({
        code: "KEY_MISMATCH",
        message: `Live scale is ${pcName(liveRoot)} ${snap.liveScale.name} but detected key is ${key.best} (r=${round2(key.r ?? 0)})`,
      });
    }
  }
  // OFF_KEY — the ratio itself is measured once in analyzeMusicState and
  // rides ctx; the goal layer's in_key criterion reads the same number.
  if (ctx.offKey && ctx.offKey.ratio > OFF_KEY_THRESHOLD) {
    issues.push({
      code: "OFF_KEY",
      message: `${Math.round(ctx.offKey.ratio * 100)}% of note duration is outside ${ctx.offKey.scaleLabel} — check for wrong notes (or intentional chromaticism)`,
    });
  }
  if (ctx.totalAudible >= MIN_NOTES_FOR_ISSUES) {
    if (ctx.globalPitchMin >= 48) {
      issues.push({
        code: "NO_LOW_END",
        message: `lowest note is ${pitchName(ctx.globalPitchMin)} across ${ctx.totalAudible} notes — nothing below C3`,
      });
    }
    if (ctx.globalPitchMax < 72) {
      issues.push({
        code: "NO_HIGH_END",
        message: `highest note is ${pitchName(ctx.globalPitchMax)} across ${ctx.totalAudible} notes — nothing at/above C5`,
      });
    }
  }
  for (const pt of ctx.perTrack) {
    const f = pt.feats;
    if (!f || f.materialCount < MIN_NOTES_FOR_ISSUES) continue;
    if (f.velMax - f.velMin <= 6) {
      issues.push({
        code: "FLAT_DYNAMICS",
        message: `"${pt.track.name}" velocity range ${Math.round(f.velMax - f.velMin)} across ${f.materialCount} notes — sounds mechanical`,
        tracks: [pt.track.index],
      });
    }
    if (pt.role === "bass" && f.uniq <= 2) {
      issues.push({
        code: "MONOTONE_BASS",
        message: `"${pt.track.name}" plays only ${f.uniq} pitch(es) across ${f.materialCount} notes`,
        tracks: [pt.track.index],
      });
    }
  }
  // Audio rules: judge per-track source-file aggregates (trackAudio aligns
  // with perTrack). Roles are name-driven for audio-only tracks, so a kick
  // sample on a track named "Stem 1" (role unknown) intentionally can't
  // fire WEAK_TRANSIENTS — no evidence, no claim.
  for (let i = 0; i < ctx.perTrack.length; i++) {
    const a = ctx.trackAudio[i];
    if (!a) continue;
    const pt = ctx.perTrack[i];
    if ((pt.role === "kick" || pt.role === "drums") && a.crestDb < 3) {
      issues.push({
        code: "WEAK_TRANSIENTS",
        message: `"${pt.track.name}" crest ${round2(a.crestDb)} dB — transients are squashed, the ${pt.role === "kick" ? "kick" : "drums"} will lack impact ${AUDIO_CAVEAT}`,
        tracks: [pt.track.index],
      });
    }
    if (pt.role === "bass" && a.bands.sub + a.bands.bass < 0.25) {
      issues.push({
        code: "THIN_LOW_END",
        message: `"${pt.track.name}" sub+bass energy is ${Math.round((a.bands.sub + a.bands.bass) * 100)}% of its spectrum — bass sounds thin ${AUDIO_CAVEAT}`,
        tracks: [pt.track.index],
      });
    }
    if (a.dynamicRangeDb !== undefined && a.dynamicRangeDb < 6) {
      issues.push({
        code: "SQUASHED_DYNAMICS",
        message: `"${pt.track.name}" loudness range ${round2(a.dynamicRangeDb)} dB — over-compressed/flat ${AUDIO_CAVEAT}`,
        tracks: [pt.track.index],
      });
    }
  }
  // Song-wide audio balance, ENERGY-weighted over analyzed tracks (track
  // energy ∝ seconds × 10^(rmsDb/10)) — a track 28 dB down must not pull the
  // mix's balance verdict toward its own spectrum.
  {
    let totalE = 0;
    let high = 0;
    let highMid = 0;
    for (const a of ctx.trackAudio) {
      if (!a) continue;
      const e = a.durationSec * 10 ** (a.rmsDb / 10);
      totalE += e;
      high += a.bands.high * e;
      highMid += a.bands.highMid * e;
    }
    if (totalE > 0) {
      const highFrac = high / totalE;
      const highMidFrac = highMid / totalE;
      if (highFrac < 0.05) {
        issues.push({
          code: "DULL_HIGH_END",
          message: `high-band energy is ${Math.round(highFrac * 100)}% across audio clips — the mix may sound dull/muffled (based on audio clip source files only)`,
        });
      }
      if (highFrac + highMidFrac > 0.35) {
        issues.push({
          code: "HARSH_HIGH_END",
          message: `high/high-mid energy is ${Math.round((highFrac + highMidFrac) * 100)}% across audio clips — the top end may sound harsh (based on audio clip source files only)`,
        });
      }
    }
  }
  const mutedParts: string[] = [];
  if (ctx.mutedTrackNotes > 0) mutedParts.push(`${ctx.mutedTrackNotes} notes on muted tracks`);
  if (ctx.mutedClipNotes > 0) mutedParts.push(`${ctx.mutedClipNotes} notes in muted clips`);
  if (ctx.mutedNotes > 0) mutedParts.push(`${ctx.mutedNotes} muted notes`);
  if (mutedParts.length > 0) {
    issues.push({ code: "MUTED_CONTENT", message: `${mutedParts.join(", ")} — excluded from all stats` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Interpretation entry point: MusicState -> MusicAnalysis. No rounding, no
 * budget cut — machine consumers (goal layer) use this directly; present.ts
 * renders it as SongAnalysis for model-bound output. */
export function analyzeMusicState(state: MusicState): MusicAnalysis {
  const snap = state.snapshot;
  const barBeats = state.barBeats;

  // Interpretation view over the facts (order: drums pre-classify -> histogram
  // -> key -> roles, because drums must stay out of the key histogram).
  const perTrack = state.tracks.map((ts) => ({
    track: ts.track,
    isDrums: classifyDrums(ts.track),
    feats: ts.measurements,
    clipMats: ts.clips.map(
      (c): ClipMaterial => ({ clip: c.clip, win: c.window, material: c.material }),
    ),
  }));

  const { hist } = pitchClassHistogram(perTrack);
  const key = detectKey(hist);

  // One measurement, two consumers: the OFF_KEY issue and MusicAnalysis.offKey
  // (which the goal layer's in_key / off_key_lte criteria judge against).
  const offKey = measureOffKey(snap, key, perTrack);

  const roles = perTrack.map((pt) => inferRole(pt.track, pt.feats, pt.isDrums, barBeats));

  // Per-track audio aggregates, straight from state.tracks (NOT perTrack —
  // its clipMats view drops the ClipState wrapper where audio features
  // live). All null when audio enrichment never ran.
  const secPerBeat = 60 / (snap.tempo > 0 ? snap.tempo : 120);
  const trackAudio = state.tracks.map((ts) => aggregateTrackAudio(ts, secPerBeat));

  // Arrangement extent comes from the facts layer (any clip kind counts,
  // muted or not — it still occupies time).
  const arrEnd = state.arrangement.endBeat;
  const hasArrClips = state.arrangement.hasClips;
  const arrMidiClips = state.arrangement.midiClips;
  const arrangementBars = state.arrangement.bars;

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

  // Aggregates the issue rules judge against.
  let sessionClipCount = 0;
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
    offKey,
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
    trackAudio,
  });

  return {
    // Whitelist copy: KeyResult's internal root/mode must not leak into
    // MusicAnalysis (present.ts whitelists again for SongAnalysis).
    key: {
      status: key.status,
      best: key.best,
      confidence: key.confidence,
      r: key.r,
      margin: key.margin,
      candidates: key.candidates,
    },
    sections,
    trackRoles: perTrack.map((pt, i) => ({
      i: pt.track.index,
      role: roles[i],
      isDrums: pt.isDrums,
    })),
    issues,
    ...(offKey ? { offKey } : {}),
    ...(trackAudio.some((a) => a !== null) ? { trackAudio } : {}),
  };
}
