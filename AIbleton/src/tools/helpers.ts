import * as path from "node:path";
import {
  AudioClip,
  DrumRack,
  MidiClip,
  MidiTrack,
  type Clip,
  type Device,
  type DeviceParameter,
  type NoteDescription,
  type Song,
  type Track,
} from "@ableton-extensions/sdk";
import type { SnapshotClip, SongSnapshot } from "../musicstate/types.js";
import type { Ctx } from "./env.js";


// ---------- Tool execution against the Live Set ----------

export function trackAt(context: Ctx, index: number): Track<"1.0.0"> {
  const tracks = context.application.song.tracks;
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) {
    throw new Error(`轨道序号 ${index} 无效，当前共 ${tracks.length} 条轨道（0 起计）`);
  }
  return tracks[index];
}

export function midiTrackAt(context: Ctx, index: number): MidiTrack<"1.0.0"> {
  const track = trackAt(context, index);
  if (!(track instanceof MidiTrack)) {
    throw new Error(`轨道 ${index}（${track.name}）不是 MIDI 轨道`);
  }
  return track;
}

export function matchByName<T extends { name: string }>(items: readonly T[], ref: string, what: string): T {
  const q = ref.trim().toLowerCase();
  const exact = items.find((i) => i.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = items.filter((i) => i.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`${what}名称“${ref}”匹配到多个，请精确指定: ${partial.map((p) => p.name).join(", ")}`);
  }
  throw new Error(`找不到${what}“${ref}”，可选: ${items.map((i) => i.name).join(", ")}`);
}

/** Lightweight stable track reference. Every track tool accepts track_name
 * alongside its index; the name is authoritative — when the index no longer
 * points at a track with that name (tracks were added/removed/reordered
 * since the model last called get_song_overview), the track is re-resolved
 * by name instead of silently hitting the wrong track. */
export interface TrackRef {
  track: Track<"1.0.0">;
  index: number;
  /** The stale index the caller passed, when it had drifted. */
  refreshedFrom?: number;
}

export function resolveTrack(
  context: Ctx,
  input: Record<string, unknown>,
  indexKey: "index" | "track_index",
): TrackRef {
  const tracks = context.application.song.tracks;
  const raw = input[indexKey];
  const hasIndex = typeof raw === "number" && Number.isInteger(raw);
  const name = typeof input.track_name === "string" ? input.track_name.trim() : "";

  if (name) {
    if (
      hasIndex && raw >= 0 && raw < tracks.length &&
      tracks[raw].name.trim().toLowerCase() === name.toLowerCase()
    ) {
      return { track: tracks[raw], index: raw };
    }
    // Index missing or drifted — resolve fresh by name.
    const track = matchByName(tracks, name, "轨道");
    const index = tracks.indexOf(track);
    return hasIndex && index !== raw ? { track, index, refreshedFrom: raw } : { track, index };
  }
  if (!hasIndex) throw new Error(`请提供 ${indexKey}（0 起计）或 track_name`);
  if (raw < 0 || raw >= tracks.length) {
    throw new Error(`轨道序号 ${raw} 无效，当前共 ${tracks.length} 条轨道（0 起计）`);
  }
  return { track: tracks[raw], index: raw };
}

/** Adds the fresh index (and a drift note) to a track tool's result so the
 * model can correct its bookkeeping for follow-up calls. */
export function trackResult(ref: TrackRef, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    track_index: ref.index,
    ...(ref.refreshedFrom !== undefined
      ? { index_refreshed: `轨道索引已漂移（${ref.refreshedFrom} → ${ref.index}），已按名称“${ref.track.name}”重新定位` }
      : {}),
  };
}

export function deviceAt(context: Ctx, trackIndex: number, ref: unknown): Device<"1.0.0"> {
  const track = trackAt(context, trackIndex);
  const devices = track.devices;
  if (!devices.length) throw new Error(`轨道 ${trackIndex}（${track.name}）上没有任何设备`);
  if (typeof ref === "number") {
    if (!Number.isInteger(ref) || ref < 0 || ref >= devices.length) {
      throw new Error(`设备序号 ${ref} 无效，该轨道共 ${devices.length} 个设备（0 起计）`);
    }
    return devices[ref];
  }
  if (typeof ref === "string" && ref.trim()) return matchByName(devices, ref, "设备");
  throw new Error("请提供 device_index 或 device_name");
}

export function paramAt(device: Device<"1.0.0">, ref: unknown): DeviceParameter<"1.0.0"> {
  const params = device.parameters;
  if (typeof ref === "number") {
    if (!Number.isInteger(ref) || ref < 0 || ref >= params.length) {
      throw new Error(`参数序号 ${ref} 无效，${device.name} 共 ${params.length} 个参数（0 起计）`);
    }
    return params[ref];
  }
  if (typeof ref === "string" && ref.trim()) return matchByName(params, ref, "参数");
  throw new Error("请提供 parameter_index 或 parameter_name");
}

export async function setParamValue(param: DeviceParameter<"1.0.0">, value: number): Promise<number> {
  const clamped = Math.min(param.max, Math.max(param.min, value));
  await param.setValue(clamped);
  return clamped;
}

export function deviceRefFrom(input: Record<string, unknown>): unknown {
  if (typeof input.device_name === "string" && input.device_name.trim()) return input.device_name;
  if (typeof input.device_index === "number") return input.device_index;
  throw new Error("请提供 device_index 或 device_name");
}

/** The Extension Host bridge hands back BigInt for some numeric getters
 * (Scene.signatureNumerator confirmed on real Live 12.4.5) — normalize every
 * number crossing the host boundary or arithmetic blows up downstream. */
export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v as number);
  return Number.isFinite(n) ? n : fallback;
}

/** Serialize a Live clip for analyzeSong. `start` is null for session clips. */
export function snapshotClip(c: Clip<"1.0.0">, start: number | null): SnapshotClip {
  const base = {
    name: String(c.name ?? ""),
    start,
    duration: toNum(c.duration),
    looping: !!c.looping,
    loopStart: toNum(c.loopStart),
    loopEnd: toNum(c.loopEnd),
    startMarker: toNum(c.startMarker),
    muted: !!c.muted,
  };
  if (c instanceof MidiClip) {
    return {
      ...base,
      kind: "midi",
      notes: c.notes.map((n) => ({
        pitch: toNum(n.pitch),
        start: toNum(n.startTime),
        duration: toNum(n.duration),
        velocity: toNum(n.velocity ?? 100, 100),
        muted: !!n.muted,
      })),
    };
  }
  return {
    ...base,
    kind: "audio",
    file: c instanceof AudioClip && c.filePath ? path.basename(c.filePath) : undefined,
    filePath: c instanceof AudioClip && c.filePath ? String(c.filePath) : undefined,
  };
}

/** Build the plain-data SongSnapshot analyzeSong runs on. Every field is
 * `??`-guarded: smoke tests boot the server with a minimal fake song. */
export function buildSongSnapshot(song: Song<"1.0.0">): SongSnapshot {
  const scenes = song.scenes ?? [];
  const s0 = scenes[0];
  return {
    tempo: toNum(song.tempo, 120),
    timeSig: {
      numerator: toNum(s0?.signatureNumerator) || 4,
      denominator: toNum(s0?.signatureDenominator) || 4,
    },
    liveScale: {
      mode: !!song.scaleMode,
      root: toNum(song.rootNote),
      name: String(song.scaleName ?? ""),
      intervals: (song.scaleIntervals ?? []).map((v) => toNum(v)),
    },
    cuePoints: (song.cuePoints ?? []).map((c) => ({ time: toNum(c.time), name: String(c.name ?? "") })),
    sceneCount: scenes.length,
    tracks: (song.tracks ?? []).map((t, i) => {
      const rack = t.devices.find((d): d is DrumRack<"1.0.0"> => d instanceof DrumRack);
      const clips: SnapshotClip[] = [];
      t.arrangementClips.forEach((c, k) => {
        const sc = snapshotClip(c, toNum(c.startTime));
        sc.arrIndex = k; // matches clip_index of get/set_clip_notes
        clips.push(sc);
      });
      t.clipSlots.forEach((slot, k) => {
        if (!slot.clip) return;
        const sc = snapshotClip(slot.clip, null);
        sc.scene = k; // matches scene_index of write_session_clip
        clips.push(sc);
      });
      return {
        index: i,
        name: String(t.name ?? ""),
        type: t instanceof MidiTrack ? ("midi" as const) : ("audio" as const),
        mute: !!t.mute,
        mutedViaSolo: !!t.mutedViaSolo,
        group: t.groupTrack?.name ?? undefined,
        drumPads: rack?.chains.map((ch) => toNum(ch.receivingNote)),
        devices: t.devices.map((d) => String(d.name ?? "")).slice(0, 6),
        clips,
      };
    }),
  };
}

export function parseNotes(raw: unknown, clipLength: number): NoteDescription[] {
  if (!Array.isArray(raw)) throw new Error("notes 必须是数组");
  const notes = raw.map((n) => {
    const note = n as Record<string, unknown>;
    const pitch = Math.round(Number(note.pitch));
    const startTime = Number(note.start);
    const duration = Number(note.duration ?? 0.25);
    const velocity = Math.round(Number(note.velocity ?? 100));
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
      throw new Error(`pitch ${String(note.pitch)} 无效（应为 0–127 的整数）`);
    }
    if (!(startTime >= 0) || !(duration > 0)) {
      throw new Error(`音符 start=${String(note.start)} / duration=${String(note.duration)} 无效`);
    }
    return {
      pitch,
      startTime,
      duration,
      velocity: Math.min(127, Math.max(1, velocity)),
    };
  });
  return notes.filter((n) => n.startTime < clipLength);
}

/**
 * Bakes swing into note timing: offbeat 16th notes are delayed (and slightly
 * softened), like a classic MPC/16th-note groove. swingPct 0–100 maps to a
 * delay of 0–1/12 beat (100 = full triplet swing). Off-grid notes are untouched.
 */
export function applySwing(notes: NoteDescription[], swingPct: number): NoteDescription[] {
  const amount = Number(swingPct);
  if (!(amount > 0)) return notes;
  const delay = Math.min(100, amount) / 100 / 12; // in beats
  return notes.map((n) => {
    const sixteenth = n.startTime * 4;
    const nearest = Math.round(sixteenth);
    if (Math.abs(sixteenth - nearest) < 0.02 && nearest % 2 === 1) {
      return {
        ...n,
        startTime: n.startTime + delay,
        velocity: Math.max(1, Math.round((n.velocity ?? 100) * 0.85)),
      };
    }
    return n;
  });
}
