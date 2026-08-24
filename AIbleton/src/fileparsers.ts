/**
 * Parsers for binary music attachments (.mid / .als).
 *
 * The LLM APIs can't ingest these formats, so each parser converts the file
 * into a compact TEXT summary that is folded into the chat message — the
 * model reasons over the summary, never the raw bytes.
 */

import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

const HARD_CAP = 8000;

// ---------------------------------------------------------------- MIDI ----

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchName = (p: number) => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);

/** General MIDI program names (0-based). */
const GM_PROGRAMS = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano",
  "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet", "Celesta", "Glockenspiel",
  "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion",
  "Harmonica", "Tango Accordion", "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)",
  "Electric Guitar (jazz)", "Electric Guitar (clean)", "Electric Guitar (muted)",
  "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics", "Acoustic Bass",
  "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass", "Slap Bass 1",
  "Slap Bass 2", "Synth Bass 1", "Synth Bass 2", "Violin", "Viola", "Cello", "Contrabass",
  "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani", "String Ensemble 1",
  "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs",
  "Synth Voice", "Orchestra Hit", "Trumpet", "Trombone", "Tuba", "Muted Trumpet",
  "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2", "Soprano Sax", "Alto Sax",
  "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet", "Piccolo",
  "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)",
  "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass+lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)",
  "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)", "FX 1 (rain)", "FX 2 (soundtrack)",
  "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)",
  "FX 7 (echoes)", "FX 8 (sci-fi)", "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba",
  "Bagpipe", "Fiddle", "Shanai", "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock",
  "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal", "Guitar Fret Noise",
  "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot",
];

/** Key-signature meta event: sf = sharps(+)/flats(-), mi = 0 major / 1 minor. */
const KEY_MAJOR = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const KEY_MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"];

interface MidiNote { tick: number; beats: number; pitch: number; velocity: number }
interface MidiTrack {
  name: string;
  channel: number; // -1 = mixed/none
  program: number; // -1 = unset
  notes: MidiNote[];
  ccCount: number;
}

class Reader {
  pos = 0;
  constructor(public buf: Buffer) {}
  u8() { return this.buf[this.pos++]; }
  u16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  str(n: number) { const s = this.buf.toString("latin1", this.pos, this.pos + n); this.pos += n; return s; }
  varlen() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    return v;
  }
  skip(n: number) { this.pos += n; }
}

/** Parse a Standard MIDI File and return a compact text summary for the LLM. */
export function parseMidi(buf: Buffer): string {
  const r = new Reader(buf);
  if (r.str(4) !== "MThd") throw new Error("缺少 MThd 头，不是标准 MIDI 文件");
  const headLen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = 8 + headLen; // tolerate oversized headers

  const smpte = (division & 0x8000) !== 0;
  const tpq = smpte ? 0 : division; // ticks per quarter note

  const tempos: { tick: number; usPerQn: number }[] = [];
  let timeSig = "";
  let keySig = "";
  const tracks: MidiTrack[] = [];

  for (let ti = 0; ti < ntrks && r.pos < buf.length; ti++) {
    if (r.str(4) !== "MTrk") break;
    const len = r.u32();
    const end = r.pos + len;
    const track: MidiTrack = { name: "", channel: -1, program: -1, notes: [], ccCount: 0 };
    const pending = new Map<string, number[]>(); // ch:pitch -> indices into track.notes
    let tick = 0, status = 0;

    while (r.pos < end) {
      tick += r.varlen();
      let b = r.u8();
      if (b < 0x80) { r.pos--; b = status; } else if (b < 0xf0) status = b;

      if (b === 0xff) { // meta
        const type = r.u8(), n = r.varlen();
        const dataStart = r.pos;
        if (type === 0x03 && !track.name) track.name = r.str(n).replace(/[\x00-\x1f]/g, "").trim();
        else if (type === 0x51 && n === 3) { const us = (r.u8() << 16) | (r.u8() << 8) | r.u8(); tempos.push({ tick, usPerQn: us }); }
        else if (type === 0x58 && n >= 2 && !timeSig) timeSig = `${r.u8()}/${2 ** r.u8()}`;
        else if (type === 0x59 && n >= 2 && !keySig) {
          const sf = (r.u8() << 24) >> 24, mi = r.u8();
          const table = mi ? KEY_MINOR : KEY_MAJOR;
          keySig = `${table[sf + 7] ?? "?"} ${mi ? "minor" : "major"}`;
        }
        r.pos = dataStart + n; // skip whatever the handler didn't consume
        if (type === 0x2f) break;
      } else if (b === 0xf0 || b === 0xf7) {
        r.skip(r.varlen());
      } else {
        const kind = b & 0xf0, ch = b & 0x0f;
        if (track.channel === -1) track.channel = ch;
        else if (track.channel !== ch) track.channel = 99; // mixed
        switch (kind) {
          case 0x90: {
            const pitch = r.u8(), vel = r.u8();
            if (vel === 0) { closeNote(track, pending, ch, pitch, tick, tpq); break; }
            track.notes.push({ tick, beats: 0, pitch, velocity: vel });
            const k = `${ch}:${pitch}`;
            (pending.get(k) ?? pending.set(k, []).get(k)!).push(track.notes.length - 1);
            break;
          }
          case 0x80: { const pitch = r.u8(); r.u8(); closeNote(track, pending, ch, pitch, tick, tpq); break; }
          case 0xb0: r.u8(); r.u8(); track.ccCount++; break;
          case 0xc0: { const p = r.u8(); if (track.program === -1) track.program = p; break; }
          case 0xa0: case 0xe0: r.skip(2); break;
          case 0xd0: r.skip(1); break;
          default: r.pos = end; // unknown status — bail out of this track
        }
      }
    }
    r.pos = end;
    if (track.notes.length || track.name) tracks.push(track);
  }

  // Duration in seconds via the tempo map (default 120 BPM).
  tempos.sort((a, b) => a.tick - b.tick);
  // Measure to the END of the last note, not its note-on.
  const lastTick = Math.max(0, ...tracks.flatMap((t) => t.notes.map((n) => n.tick + n.beats * tpq)));
  let seconds = 0;
  if (smpte) {
    const fps = 256 - (division >> 8), tpf = division & 0xff;
    seconds = lastTick / (fps * tpf);
  } else {
    let usPerQn = 500000, prevTick = 0;
    for (const t of tempos) {
      if (t.tick > lastTick) break;
      seconds += ((t.tick - prevTick) / tpq) * (usPerQn / 1e6);
      prevTick = t.tick; usPerQn = t.usPerQn;
    }
    seconds += ((lastTick - prevTick) / tpq) * (usPerQn / 1e6);
  }

  const lines: string[] = [];
  const fmt = `format ${format}, ${tracks.length} track(s), ${smpte ? "SMPTE timing" : `${tpq} ticks/quarter`}`;
  lines.push(`MIDI 摘要：${fmt}，时长约 ${seconds.toFixed(1)} 秒`);
  const meta: string[] = [];
  if (tempos.length) {
    const bpms = [...new Set(tempos.map((t) => (6e7 / t.usPerQn).toFixed(1)))];
    meta.push(`Tempo ${bpms.join(" → ")} BPM`);
  }
  if (timeSig) meta.push(`拍号 ${timeSig}`);
  if (keySig) meta.push(`调号 ${keySig}`);
  if (meta.length) lines.push(meta.join("；"));

  const MAX_TRACKS = 12, MAX_FIRST_NOTES = 24;
  for (const [i, tr] of tracks.slice(0, MAX_TRACKS).entries()) {
    if (!tr.notes.length) { lines.push(`Track ${i + 1}${tr.name ? ` "${tr.name}"` : ""}：无音符（控制/自动化轨）`); continue; }
    const chDesc = tr.channel === 9 ? "ch 10 (GM 打击乐)" : tr.channel === 99 ? "多通道" : `ch ${tr.channel + 1}`;
    const prog = tr.program >= 0 && tr.channel !== 9 ? `，${GM_PROGRAMS[tr.program] ?? `program ${tr.program}`}` : "";
    const lo = Math.min(...tr.notes.map((n) => n.pitch));
    const hi = Math.max(...tr.notes.map((n) => n.pitch));
    lines.push(`Track ${i + 1}${tr.name ? ` "${tr.name}"` : ""}（${chDesc}${prog}）：${tr.notes.length} 个音符，音域 ${pitchName(lo)}–${pitchName(hi)}${tr.ccCount ? `，${tr.ccCount} 条 CC` : ""}`);

    // Pitch-class histogram — enough for the model to infer key/scale.
    const hist = new Map<string, number>();
    for (const n of tr.notes) {
      const pc = NOTE_NAMES[n.pitch % 12];
      hist.set(pc, (hist.get(pc) ?? 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`);
    lines.push(`  音级分布：${top.join(" ")}`);

    const beats = (t: number) => (tpq ? (t / tpq) : t);
    const fmtNum = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
    const first = tr.notes.slice(0, MAX_FIRST_NOTES)
      .map((n) => `${fmtNum(beats(n.tick))}:${pitchName(n.pitch)}(${n.beats ? fmtNum(n.beats) + "b" : "?"})`);
    lines.push(`  前 ${Math.min(tr.notes.length, MAX_FIRST_NOTES)} 音（拍:音(时值)）：${first.join(" ")}${tr.notes.length > MAX_FIRST_NOTES ? " …" : ""}`);
  }
  if (tracks.length > MAX_TRACKS) lines.push(`…另有 ${tracks.length - MAX_TRACKS} 条轨道未列出`);

  return lines.join("\n").slice(0, HARD_CAP);
}

function closeNote(track: MidiTrack, pending: Map<string, number[]>, ch: number, pitch: number, tick: number, tpq: number) {
  const k = `${ch}:${pitch}`;
  const stack = pending.get(k);
  const idx = stack?.shift();
  if (idx === undefined) return;
  const n = track.notes[idx];
  n.beats = tpq ? Math.max(0, tick - n.tick) / tpq : 0;
}

// ----------------------------------------------------------------- ALS ----

interface AlsTrack { type: string; name: string; devices: string[]; samples: string[] }

const attrRe = /([A-Za-z0-9_]+)="([^"]*)"/g;
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(attrRe)) out[m[1]] = m[2];
  return out;
}

/**
 * Summarize an Ableton Live Set (.als = gzipped XML) for the LLM:
 * version, tempo, time signature, and per-track name / device chain / samples.
 */
export function summarizeAls(buf: Buffer): string {
  const xml = gunzipSync(buf).toString("utf8");
  if (!xml.includes("<Ableton")) throw new Error("gunzip 成功但不含 <Ableton> 根节点，不是 Live 工程");

  const root = xml.match(/<Ableton([^>]*)>/);
  const ra = root ? attrs(root[1]) : {};
  const version = [ra.MajorVersion, ra.MinorVersion].filter(Boolean).join(" ");

  const stack: string[] = [];
  const tracks: AlsTrack[] = [];
  let cur: AlsTrack | null = null;
  let pendingPlugin = -1; // index into cur.devices awaiting a PlugName
  let tempo = "", timeN = "", timeD = "", scenes = 0;

  const tagRe = /<(\/?)([A-Za-z0-9_]+)((?:\s+[A-Za-z0-9_]+="[^"]*")*)\s*(\/?)>/g;
  for (const m of xml.matchAll(tagRe)) {
    const [, closing, tag, attrStr, selfClose] = m;
    if (closing) {
      if (stack[stack.length - 1] === tag) stack.pop();
      if (tag === "PluginDevice" || tag === "AuPluginDevice") pendingPlugin = -1;
      if ((tag.endsWith("Track")) && cur && (tag === cur.type)) cur = null;
      continue;
    }
    const at = attrStr ? attrs(attrStr) : {};
    const top = stack[stack.length - 1];
    const inTrack = cur !== null;

    // MidiTrack/AudioTrack/GroupTrack live under <Tracks>; ReturnTrack and
    // MasterTrack may sit directly under <LiveSet> depending on Live version.
    if (!inTrack && /^(MidiTrack|AudioTrack|GroupTrack)$/.test(tag) && top === "Tracks"
        || !inTrack && /^(ReturnTrack|MasterTrack)$/.test(tag) && (top === "Tracks" || top === "LiveSet")) {
      cur = { type: tag, name: "", devices: [], samples: [] };
      tracks.push(cur);
    } else if (inTrack && top === "Name" && tag === "EffectiveName" && !cur!.name) {
      cur!.name = at.Value ?? "";
    } else if (inTrack && top === "Devices") {
      // Direct child of <Devices> = a device. Stock devices ARE the tag name;
      // plugins are PluginDevice/AuPluginDevice with the real name nested deeper.
      const label = /^(PluginDevice|AuPluginDevice)$/.test(tag) ? null : tag;
      if (cur!.devices.length < 12) {
        cur!.devices.push(label ?? "插件");
        if (label === null) pendingPlugin = cur!.devices.length - 1;
      }
    } else if (inTrack && pendingPlugin >= 0 && (tag === "PlugName" || (tag === "Name" && stack.includes("AuPluginInfo")))) {
      cur!.devices[pendingPlugin] = at.Value || "插件";
      pendingPlugin = -1;
    } else if (inTrack && stack.includes("FileRef") && (tag === "Name" || tag === "RelativePath") && at.Value && cur!.samples.length < 8) {
      // FileRef usually carries only paths — take the basename as sample name.
      const base = at.Value.split(/[/\\]/).filter(Boolean).pop() ?? "";
      if (base && !cur!.samples.includes(base)) cur!.samples.push(base);
    } else if (!inTrack && stack.includes("Tempo") && tag === "Manual" && !tempo) {
      tempo = at.Value ?? "";
    } else if (!inTrack && stack.includes("TimeSignatures") && tag === "Numerator" && !timeN) {
      timeN = at.Value ?? "";
    } else if (!inTrack && stack.includes("TimeSignatures") && tag === "Denominator" && !timeD) {
      timeD = at.Value ?? "";
    } else if (tag === "Scene" && stack.includes("Scenes")) {
      scenes++;
    }
    if (!selfClose) stack.push(tag);
  }

  const typeLabel: Record<string, string> = {
    MidiTrack: "MIDI", AudioTrack: "音频", GroupTrack: "编组", ReturnTrack: "返送", MasterTrack: "总线",
  };
  const lines: string[] = [];
  lines.push(`Ableton Live 工程摘要：Live ${version || "版本未知"}，${tracks.length} 条轨道${scenes ? `，${scenes} 个场景` : ""}`);
  const meta: string[] = [];
  if (tempo) meta.push(`Tempo ${(+tempo).toFixed(1)} BPM`);
  if (timeN && timeD) meta.push(`拍号 ${timeN}/${timeD}`);
  if (meta.length) lines.push(meta.join("；"));

  for (const [i, tr] of tracks.slice(0, 24).entries()) {
    const parts = [`[${typeLabel[tr.type] ?? tr.type}] ${tr.name || "(未命名)"}`];
    if (tr.devices.length) parts.push(`装置: ${tr.devices.join(" → ")}`);
    if (tr.samples.length) parts.push(`采样: ${tr.samples.join(", ")}`);
    lines.push(`${i + 1}. ${parts.join(" ｜ ")}`);
  }
  if (tracks.length > 24) lines.push(`…另有 ${tracks.length - 24} 条轨道未列出`);

  return lines.join("\n").slice(0, HARD_CAP);
}

// ------------------------------------------------------------- dispatch ----

/** Parse a binary attachment into its text summary; never throws. */
export function describeBinaryAttachment(name: string, kind: string, base64: string): string {
  try {
    const buf = Buffer.from(base64, "base64");
    if (!buf.length) return "（文件为空）";
    return kind === "midi" ? parseMidi(buf) : summarizeAls(buf);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `（${name} 解析失败：${why}）`;
  }
}
