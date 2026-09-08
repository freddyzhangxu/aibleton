/**
 * movebundle.ts — parser for Ableton Move Sets (.ablbundle).
 *
 * Verified against real device downloads (firmware 2.1, Song schema 1.8.3):
 * an .ablbundle is a plain zip (usually STORED, local headers carry the
 * data-descriptor flag so sizes only exist in the central directory) with:
 *
 *   Song.abl        — the whole Set as pretty-printed JSON
 *                     ($schema: http://tech.ableton.com/schema/song/1.8.3/song.json)
 *   BundleInfo.json — {"originalSampleUris": {bundle path → source uri}}
 *   Samples/*.wav   — the audio the Set references
 *
 * Pure functions over Buffers — no SDK, no fs, no network (same discipline as
 * analysis.ts): server.ts downloads the bundle, this module turns it into a
 * SongSnapshot for analyzeSong() plus a Move-specific extras block.
 *
 * Move data model notes (differ from Live):
 * - No arrangement view: every clip is a session clip in track.clipSlots[i]
 *   (slot index = scene index). isEnabled=false means the clip is muted.
 * - No track mute flag either: mixer.speakerOn=false mutes the track,
 *   mixer["solo-cue"]=true solos it.
 * - region.start/end are the clip's playable window in beats; with looping on,
 *   region.loop is the loop window and the audible window is region ∩ loop.
 * - Note times are beats relative to the clip; pitches are plain MIDI numbers.
 * - Drum pads have no receivingNote — the drum cells sit in
 *   instrumentRack → drumRack → drumCell order, so drumPads are approximated
 *   by the distinct pitches the track actually plays (drum tracks only).
 * - Scale names use modes ("Phrygian", "Minor Pentatonic", …); UNKNOWN_SCALE
 *   falls back to chromatic + mode:false instead of guessing intervals.
 */

import { inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";
import type { SnapshotClip, SnapshotNote, SnapshotTrack, SongSnapshot } from "./musicstate/types.js";

// ---------------------------------------------------------------------------
// Minimal zip reader (central directory based; STORE + DEFLATE)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Extract all entries of a zip into a name → data map. Throws on truncated
 * or unsupported archives (multi-disk, encryption, exotic methods). */
export function unzipEntries(buf: Buffer): Map<string, Buffer> {
  // End Of Central Directory: scan backwards from the earliest possible EOCD.
  let eocd = -1;
  const minScan = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minScan; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录结尾记录）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error("zip 中央目录损坏");
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory marker

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error(`zip 条目 ${name} 的本地头损坏`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`zip 条目 ${name} 数据截断`);
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw); // copy out of the parent buffer
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`zip 条目 ${name} 用了不支持的压缩方式（method ${method}）`);
    }
    out.set(name, data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Song.abl shape (only the fields we read — everything else passes through)
// ---------------------------------------------------------------------------

interface MoveRegion {
  start?: number;
  end?: number;
  loop?: { start?: number; end?: number; isEnabled?: boolean };
}

interface MoveClip {
  name?: string;
  isEnabled?: boolean;
  region?: MoveRegion;
  sampleUri?: string;
  notes?: {
    noteNumber?: number;
    startTime?: number;
    duration?: number;
    velocity?: number;
  }[];
}

interface MoveDevice {
  kind?: string;
  name?: string;
  chains?: { devices?: MoveDevice[] }[];
}

interface MoveTrack {
  kind?: string;
  name?: string;
  clipSlots?: { clip?: MoveClip | null }[];
  devices?: MoveDevice[];
  mixer?: { pan?: number; volume?: number; speakerOn?: boolean; "solo-cue"?: boolean };
}

export interface MoveSong {
  $schema?: string;
  tempo?: number;
  timeSignature?: { upper?: number; lower?: number };
  rootNote?: number;
  scale?: string;
  tracks?: MoveTrack[];
  scenes?: { name?: string }[];
  grooves?: { name?: string }[];
}

// ---------------------------------------------------------------------------
// Bundle parse
// ---------------------------------------------------------------------------

export interface MoveSampleInfo {
  /** Path inside the bundle, URL-decoded ("Samples/Kick BNYX 1.wav"). */
  name: string;
  /** Audio duration in whole seconds (0 if the WAV header can't be read). */
  seconds: number;
  bytes: number;
  /** "pack" = shipped with the Move core library, "user" = recorded/imported. */
  origin: "pack" | "user";
}

export interface MoveBundle {
  song: MoveSong;
  samples: MoveSampleInfo[];
  /** $schema URL tail, e.g. "song/1.8.3" — for version drift warnings. */
  schemaTag: string;
}

/** WAV duration from the RIFF header: dataBytes / (rate × blockAlign). */
function wavSeconds(buf: Buffer): number {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
    // Walk chunks: fmt for byte rate, data for payload size.
    let off = 12;
    let byteRate = 0;
    let dataBytes = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      // fmt layout from chunk start: id(4) size(4) format(2) channels(2)
      // sampleRate(4) byteRate(4) — byteRate sits at offset 16.
      if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
      if (id === "data") dataBytes = size;
      off += 8 + size + (size % 2);
    }
    return byteRate > 0 ? Math.round(dataBytes / byteRate) : 0;
  } catch {
    return 0;
  }
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseMoveBundle(buf: Buffer): MoveBundle {
  const entries = unzipEntries(buf);
  const songRaw = entries.get("Song.abl");
  if (!songRaw) throw new Error("这不是一个 Move Set：包里没有 Song.abl");
  let song: MoveSong;
  try {
    song = JSON.parse(songRaw.toString("utf8")) as MoveSong;
  } catch {
    throw new Error("Song.abl 不是有效的 JSON — 固件格式可能已变化");
  }

  let origins: Record<string, string> = {};
  const infoRaw = entries.get("BundleInfo.json");
  if (infoRaw) {
    try {
      const info = JSON.parse(infoRaw.toString("utf8")) as {
        originalSampleUris?: Record<string, string>;
      };
      origins = info.originalSampleUris ?? {};
    } catch {
      /* BundleInfo is best-effort */
    }
  }

  const samples: MoveSampleInfo[] = [];
  for (const [name, data] of entries) {
    if (name === "Song.abl" || name === "BundleInfo.json") continue;
    const src = origins[name] ?? origins[encodeURIComponent(name).replace(/%2F/g, "/")] ?? "";
    samples.push({
      name: dec(name),
      seconds: name.toLowerCase().endsWith(".wav") ? wavSeconds(data) : 0,
      bytes: data.length,
      origin: src.startsWith("ableton:/packs/") ? "pack" : "user",
    });
  }
  samples.sort((a, b) => a.name.localeCompare(b.name));

  const m = String(song.$schema ?? "").match(/song\/([\d.]+)\/song\.json/);
  return { song, samples, schemaTag: m ? m[1] : "unknown" };
}

// ---------------------------------------------------------------------------
// MoveSong → SongSnapshot (for analyzeSong)
// ---------------------------------------------------------------------------

/** Move scale names → semitone intervals from the root. Modes included;
 * anything missing falls through to UNKNOWN_SCALE (chromatic, mode off). */
const SCALE_INTERVALS: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  "Harmonic Minor": [0, 2, 3, 5, 7, 8, 11],
  "Melodic Minor": [0, 2, 3, 5, 7, 9, 11],
  "Major Pentatonic": [0, 2, 4, 7, 9],
  "Minor Pentatonic": [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
};
const UNKNOWN_SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** First device of a kind anywhere in the (possibly nested) chain tree. */
function findDevice(devs: MoveDevice[] | undefined, kind: string): MoveDevice | null {
  for (const d of devs ?? []) {
    if (d.kind === kind) return d;
    for (const c of d.chains ?? []) {
      const hit = findDevice(c.devices, kind);
      if (hit) return hit;
    }
  }
  return null;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function moveClip(clip: MoveClip, scene: number, trackKind: string): SnapshotClip {
  const region = clip.region ?? {};
  const rStart = region.start ?? 0;
  const rEnd = region.end ?? rStart;
  const loop = region.loop;
  const looping = !!loop?.isEnabled;
  const lStart = loop?.start ?? rStart;
  const lEnd = loop?.end ?? rEnd;
  // Audible window = region ∩ loop (loop can overshoot the region — clip then
  // plays only up to the region end, so the window must be clamped).
  const winStart = Math.max(rStart, lStart);
  const winEnd = Math.min(rEnd, lEnd);
  const duration = Math.max(0, rEnd - rStart);

  const base: SnapshotClip = {
    kind: trackKind === "midi" ? "midi" : "audio",
    name: String(clip.name ?? ""),
    start: null, // Move has no arrangement — every clip is a session clip
    duration,
    looping,
    loopStart: winStart,
    loopEnd: Math.max(winStart, winEnd),
    startMarker: rStart,
    muted: clip.isEnabled === false,
    scene,
  };
  if (trackKind === "midi") {
    const notes: SnapshotNote[] = (clip.notes ?? [])
      .filter((n) => typeof n.noteNumber === "number")
      .map((n) => ({
        pitch: Math.round(n.noteNumber ?? 0),
        start: n.startTime ?? 0,
        duration: Math.max(0, n.duration ?? 0.25),
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? 100))),
      }));
    base.notes = notes;
    // A clip with no notes is silent — a disabled one already carries muted.
    if (notes.length === 0) base.muted = true;
  } else {
    base.file = clip.sampleUri ? dec(basename(clip.sampleUri)) : undefined;
  }
  return base;
}

export function moveSongToSnapshot(song: MoveSong): SongSnapshot {
  const tracks = song.tracks ?? [];
  const anySolo = tracks.some((t) => t.mixer?.["solo-cue"] === true);
  const scaleName = String(song.scale ?? "");
  const known = Object.prototype.hasOwnProperty.call(SCALE_INTERVALS, scaleName);

  return {
    tempo: song.tempo ?? 120,
    timeSig: {
      numerator: song.timeSignature?.upper || 4,
      denominator: song.timeSignature?.lower || 4,
    },
    liveScale: {
      mode: known,
      root: song.rootNote ?? 0,
      name: scaleName,
      intervals: known ? SCALE_INTERVALS[scaleName] : UNKNOWN_SCALE,
    },
    cuePoints: [], // Move has no cue points
    sceneCount: (song.scenes ?? []).length,
    tracks: tracks.map((t, i): SnapshotTrack => {
      const kind = t.kind === "midi" ? "midi" : "audio";
      const clips = (t.clipSlots ?? [])
        .map((slot, k) => (slot.clip ? moveClip(slot.clip, k, kind) : null))
        .filter((c): c is SnapshotClip => c !== null);
      const isDrums = kind === "midi" && !!findDevice(t.devices, "drumRack");
      return {
        index: i,
        name: String(t.name ?? ""),
        type: kind,
        mute: t.mixer?.speakerOn === false,
        mutedViaSolo: anySolo && t.mixer?.["solo-cue"] !== true,
        drumPads: isDrums
          ? [...new Set(clips.flatMap((c) => (c.notes ?? []).map((n) => n.pitch)))].sort(
              (a, b) => a - b,
            )
          : undefined,
        devices: (t.devices ?? [])
          .map((d) => String(d.name ?? "").trim())
          .filter(Boolean)
          .slice(0, 6),
        clips,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Move-specific extras (what SongSnapshot/analyzeSong doesn't carry)
// ---------------------------------------------------------------------------

/** Per-track stats over session clips — analyzeSong's per-track fields only
 * cover arrangement clips, which Move doesn't have, so they read zero here. */
export interface MoveTrackExtras {
  i: number;
  name: string;
  volumeDb: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Top-level device (preset) names, max 6. */
  devices: string[];
  /** Enabled clips / clips with actual notes. */
  clips: number;
  /** Note count across enabled clips (MIDI tracks). */
  notes?: number;
  /** "D1-D2" pitch span across enabled clips (MIDI, notes > 0). */
  range?: string;
  /** Sample files used by enabled clips (audio tracks, max 4). */
  files?: string[];
}

export interface MoveExtras {
  schema: string;
  scale: string;
  melodicTracks: number;
  drumTracks: number;
  audioTracks: number;
  tracks: MoveTrackExtras[];
  samples: MoveSampleInfo[];
  grooves: string[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function pitchName(p: number): string {
  const c = Math.max(0, Math.min(127, Math.round(p)));
  return NOTE_NAMES[c % 12] + (Math.floor(c / 12) - 1);
}

export function moveExtras(bundle: MoveBundle): MoveExtras {
  const song = bundle.song;
  const tracks = song.tracks ?? [];
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const round2 = (x: number) => Math.round(x * 100) / 100;

  const trackExtras: MoveTrackExtras[] = tracks.map((t, i) => {
    const kind = t.kind === "midi" ? "midi" : "audio";
    const clips = (t.clipSlots ?? [])
      .map((slot, k) => (slot.clip ? moveClip(slot.clip, k, kind) : null))
      .filter((c): c is SnapshotClip => c !== null);
    const audible = clips.filter((c) => !c.muted);
    const e: MoveTrackExtras = {
      i,
      name: String(t.name ?? ""),
      volumeDb: round1(t.mixer?.volume ?? 0),
      pan: round2(t.mixer?.pan ?? 0),
      muted: t.mixer?.speakerOn === false,
      solo: t.mixer?.["solo-cue"] === true,
      devices: (t.devices ?? [])
        .map((d) => String(d.name ?? "").trim())
        .filter(Boolean)
        .slice(0, 6),
      clips: audible.length,
    };
    if (kind === "midi") {
      const notes = audible.flatMap((c) => c.notes ?? []);
      e.notes = notes.length;
      if (notes.length > 0) {
        const pitches = notes.map((n) => n.pitch);
        e.range = `${pitchName(Math.min(...pitches))}-${pitchName(Math.max(...pitches))}`;
      }
    } else {
      const files = [...new Set(audible.map((c) => c.file).filter((f): f is string => !!f))];
      if (files.length > 0) e.files = files.slice(0, 4);
    }
    return e;
  });

  return {
    schema: bundle.schemaTag,
    scale: String(song.scale ?? ""),
    melodicTracks: tracks.filter(
      (t) => t.kind === "midi" && !findDevice(t.devices, "drumRack"),
    ).length,
    drumTracks: tracks.filter((t) => t.kind === "midi" && !!findDevice(t.devices, "drumRack"))
      .length,
    audioTracks: tracks.filter((t) => t.kind !== "midi").length,
    tracks: trackExtras,
    samples: bundle.samples,
    grooves: (song.grooves ?? []).map((g) => String(g.name ?? "")).filter(Boolean),
  };
}
