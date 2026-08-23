import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AudioTrack,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  Simpler,
  type Device,
  type DeviceParameter,
  type ExtensionContext,
  type NoteDescription,
  type Track,
} from "@ableton-extensions/sdk";

// ---------- Local sample library search ----------

const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);

function sampleRoots(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Splice"),
    path.join(home, "Music", "Splice"),
    path.join(home, "Documents", "Splice"),
    path.join(home, "Music", "Ableton", "User Library"),
    path.join(home, "Music", "Ableton", "Factory Packs"),
  ];
  // Core Library of every installed Live 12 app
  try {
    for (const app of fs.readdirSync("/Applications")) {
      if (/^Ableton Live 12.*\.app$/.test(app)) {
        candidates.push(`/Applications/${app}/Contents/App-Resources/Core Library/Samples`);
      }
    }
  } catch {
    // /Applications not readable — skip Core Library.
  }
  return candidates.filter((p) => fs.existsSync(p));
}

let sampleIndex: string[] | null = null;

function buildSampleIndex(): string[] {
  if (sampleIndex) return sampleIndex;
  const roots = sampleRoots();
  const out: string[] = [];
  const stack = [...roots];
  while (stack.length && out.length < 200000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  sampleIndex = out;
  console.log(`[ai-assistant] 采样索引: ${out.length} 个文件，来源: ${roots.join(" | ")}`);
  return out;
}

// ---------- Factory 808 drum kit (Drum Essentials pack) ----------

const KIT_ROOTS = [
  path.join(os.homedir(), "Music/Ableton/Factory Packs/Drum Essentials/Samples/Drums"),
  "/Users/Shared/Ableton/Factory Packs/Drum Essentials/Samples/Drums",
];

/** GM-style note map so models can reuse standard drum programming knowledge. */
const KIT_808 = [
  { note: 36, name: "Kick", file: "Kick/Kick 808 Long.aif" },
  { note: 37, name: "Rim", file: "Rim/Rim-808.aif" },
  { note: 38, name: "Snare", file: "Snare/Snare 808 Dry.aif" },
  { note: 39, name: "Clap", file: "Clap/Clap-808.aif" },
  { note: 41, name: "Tom Low", file: "Tom/Tom-808-Low.aif" },
  { note: 42, name: "Hihat Closed", file: "Hihat/Hihat Closed 808.aif" },
  { note: 43, name: "Tom Mid", file: "Tom/Tom-808-Mid.aif" },
  { note: 45, name: "Tom Hi", file: "Tom/Tom 808 Hi I.aif" },
  { note: 46, name: "Hihat Open", file: "Hihat/Hihat Open 808 1 Onyx.aif" },
  { note: 49, name: "Cymbal", file: "Cymbal/Cymbal 808 VA90.aif" },
  { note: 75, name: "Clave", file: "Wood/Clave-808.aif" },
];
import chatInterface from "../ui/interface.html";

// ---------- Local Claude Code config (~/.claude/settings.json) ----------

interface LocalConfig {
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  model?: string;
}

let cachedConfig: LocalConfig | null | undefined;

function loadClaudeCodeConfig(): LocalConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      env?: Record<string, string>;
      model?: string;
    };
    const env = settings.env ?? {};
    cachedConfig = {
      baseUrl: env.ANTHROPIC_BASE_URL,
      authToken: env.ANTHROPIC_AUTH_TOKEN,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || settings.model,
    };
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

type Ctx = ExtensionContext<"1.0.0">;

// ---------- Claude tool definitions ----------

const TOOLS = [
  {
    name: "get_song_overview",
    description:
      "Get an overview of the current Live Set: tempo, scale, all tracks (name, type, mute/solo/arm, clips, devices) and scenes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_tempo",
    description: "Set the song tempo in BPM (20–999).",
    input_schema: {
      type: "object",
      properties: { bpm: { type: "number", description: "Tempo in BPM" } },
      required: ["bpm"],
    },
  },
  {
    name: "create_midi_track",
    description: "Create a new MIDI track, optionally with a name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "create_audio_track",
    description: "Create a new audio track, optionally with a name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "rename_track",
    description: "Rename a track by its 0-based index (as listed by get_song_overview).",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        name: { type: "string" },
      },
      required: ["index", "name"],
    },
  },
  {
    name: "set_track_state",
    description: "Mute, unmute, solo, unsolo, arm or disarm a track by its 0-based index.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        mute: { type: "boolean" },
        solo: { type: "boolean" },
        arm: { type: "boolean" },
      },
      required: ["index"],
    },
  },
  {
    name: "insert_device",
    description:
      'Insert a built-in Live device at the end of a track\'s device chain. Audible immediately: "Operator", "Wavetable" (synths), "Impulse". EMPTY and silent until loaded: "Drum Rack" (use load_drum_kit instead), "Simpler" (use load_sample instead), "Sampler" (cannot load samples via API — never use, pick Simpler). Effects: "Reverb", "Auto Filter", "Compressor", "EQ Eight", "Delay". Third-party plugins are not supported.',
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number", description: "0-based track index" },
        device_name: { type: "string" },
      },
      required: ["index", "device_name"],
    },
  },
  {
    name: "get_device_parameters",
    description:
      'List the parameters of a device on a track (works for Operator, Auto Filter, and any built-in device): name, current value, min/max, and option lists for enum parameters. device_index is the 0-based position in the track\'s device chain (see get_song_overview). Use "filter" to only return parameters whose name contains a string, e.g. "freq" or "lfo" — recommended for big devices like Operator.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        device_index: { type: "number", description: "0-based device index on the track" },
        device_name: { type: "string", description: 'Device name, e.g. "Operator" (alternative to device_index)' },
        filter: { type: "string", description: "Optional case-insensitive name filter" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "set_device_parameter",
    description:
      'Set one parameter of a device (Operator, Auto Filter, …). "parameter" accepts an exact name, a partial name (e.g. "Frequency" or "freq"), or a numeric index from get_device_parameters. "value" is a number in the device\'s own units (Hz, dB, semitones, 0–1 for macros…) — it is clamped to the parameter\'s range. For enum parameters (isQuantized with items), pass the option name as a string instead.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        device_index: { type: "number" },
        device_name: { type: "string", description: 'Device name (alternative to device_index)' },
        parameter: {
          type: "string",
          description: 'Parameter name (fuzzy ok, e.g. "freq") or its numeric index as a string',
        },
        value: {
          type: "string",
          description: 'A number as a string (e.g. "800") or, for enum parameters, the option name',
        },
      },
      required: ["track_index", "parameter", "value"],
    },
  },
  {
    name: "load_drum_kit",
    description:
      'Load Ableton\'s factory 808 drum kit into a track: builds a Drum Rack with Simpler pads loaded with real 808 samples (from the Drum Essentials pack). Reuses an existing EMPTY Drum Rack on the track if present, otherwise creates one. Pad note map (use these pitches in write_midi_clip): 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 75=Clave. THIS is the way to make drums audible — prefer it over insert_device for drums.',
    input_schema: {
      type: "object",
      properties: { track_index: { type: "number" } },
      required: ["track_index"],
    },
  },
  {
    name: "search_samples",
    description:
      'Search local sample libraries by keywords — Splice folder (if the Splice app is installed and synced), Ableton User Library, Factory Packs, and Live\'s Core Library. All keywords must match (case-insensitive, matched against the full path, so folder names count). Returns up to 30 full file paths. Use specific queries like "808 kick", "tech house loop", "vocal chop 124". Note: Splice\'s online catalog cannot be browsed — only locally synced files are searchable.',
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "import_audio_clip",
    description:
      "Import an audio file (from search_samples) into an AUDIO track's arrangement at a beat position — for loops, stems, one-shots. The file is copied into the Live project first, so it stays managed by Live.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        file_path: { type: "string", description: "Full path from search_samples" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0)" },
        duration_beats: { type: "number", description: "Optional clip length in beats" },
        warped: { type: "boolean", description: "Enable warping (default: Live's auto-warp setting)" },
      },
      required: ["track_index", "file_path"],
    },
  },
  {
    name: "load_sample",
    description:
      "Load an audio file into a Simpler on a track (reuses an existing Simpler, otherwise inserts one). For pitched/melodic one-shots: bass hits, vocal chops, stabs. For drums use load_drum_kit instead.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        file_path: { type: "string", description: "Full path from search_samples" },
      },
      required: ["track_index", "file_path"],
    },
  },
  {
    name: "write_midi_clip",
    description:
      "Create a MIDI clip in a track's arrangement and fill it with notes. Times are in beats (4/4: one bar = 4 beats, so 4 bars = 16 beats). pitch is a MIDI note number (0–127); for an Impulse drum kit use pitches 48–60 (48=kick-ish, 50=snare-ish, 54=closed hat-ish, 58=open hat-ish).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        start_beat: { type: "number", description: "Clip position in the arrangement, in beats (default 0)" },
        length_beats: { type: "number", description: "Clip length in beats (default 16 = 4 bars)" },
        name: { type: "string" },
        swing: {
          type: "number",
          description:
            "Swing amount 0–100, baked into the note timing (delays + softens offbeat 16th notes). 0=straight, 30=light MPC-style, 60=pronounced, 100=full triplet swing. The SDK cannot assign Live groove files, so swing must be baked in here.",
        },
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pitch: { type: "number" },
              start: { type: "number", description: "Note start in beats, relative to clip start" },
              duration: { type: "number", description: "Note length in beats (default 0.25)" },
              velocity: { type: "number", description: "1–127 (default 100)" },
            },
            required: ["pitch", "start"],
          },
        },
      },
      required: ["track_index", "notes"],
    },
  },
  {
    name: "write_session_clip",
    description:
      "Create a looping MIDI clip in a Session View slot (track_index × scene_index) and fill it with notes. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        scene_index: { type: "number" },
        length_beats: { type: "number", description: "Clip length in beats (default 16)" },
        name: { type: "string" },
        swing: {
          type: "number",
          description: "Swing amount 0–100, baked into note timing (see write_midi_clip)",
        },
        notes: { type: "array", items: { type: "object" } },
      },
      required: ["track_index", "scene_index", "notes"],
    },
  },
  {
    name: "get_clip_notes",
    description: "Read the notes of an arrangement MIDI clip (track_index + clip_index from get_song_overview order).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        clip_index: { type: "number" },
      },
      required: ["track_index", "clip_index"],
    },
  },
  {
    name: "set_clip_notes",
    description: "Replace all notes of an existing arrangement MIDI clip. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        clip_index: { type: "number" },
        notes: { type: "array", items: { type: "object" } },
      },
      required: ["track_index", "clip_index", "notes"],
    },
  },
  {
    name: "set_track_mixer",
    description:
      "Set a track's mixer settings: volume (0–1, where 0.85 ≈ 0 dB) and/or pan (-1 = full left, 0 = center, 1 = full right).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        volume: { type: "number" },
        pan: { type: "number" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "create_scene",
    description: "Create a new scene, optionally named. Appended at the end unless index is given.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        index: { type: "number", description: "0-based insert position, -1 appends" },
      },
    },
  },
  {
    name: "rename_scene",
    description: "Rename a scene by its 0-based index.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        name: { type: "string" },
      },
      required: ["index", "name"],
    },
  },
];

const SYSTEM_PROMPT = `You are an AI music-production assistant living inside Ableton Live 12.
You can chat about music production and ALSO directly operate the user's Live Set with the provided tools.

Rules:
- Reply in the same language the user writes in (default: Chinese).
- Be concise and practical. No fluff.
- Before calling tools that modify the Set, briefly say what you are about to do.
- Track indices are 0-based, matching get_song_overview output. Call get_song_overview first whenever you need current track/scene info.
- You CAN adjust device parameters (Operator, Reverb, Auto Filter, …) and track volume/pan — see the device-control section below.
- You cannot delete anything, load third-party plugins, or do realtime audio/MIDI processing. Say so if asked.
- After tools run, confirm what changed in one short sentence.

Making music that actually produces sound:
- A MIDI track without an instrument is SILENT, and a bare "Drum Rack" is EMPTY and silent too.
- For drums: ALWAYS call load_drum_kit(track_index) — it loads Ableton's factory 808 samples into a Drum Rack. Pad pitches: 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 75=Clave. Write MIDI with exactly these pitches.
- For bass/melody/pads: insert "Operator" or "Wavetable" (both audible immediately). Wavetable sound design: use get_device_parameters with filters like "wavetable" (position), "osc", "unison", "filter" then set_device_parameter.
- For sample playback: load_sample into a Simpler (then tweak its params freely). NEVER insert "Sampler" — samples cannot be loaded into it via the API, so it stays silent.
- Then write notes with write_midi_clip (arrangement) or write_session_clip (session). Times are in beats: in 4/4, bar = 4 beats, 4 bars = 16 beats.
- Classic 4-bar techno pattern: kick (36) on every beat 0..15; clap (39) or snare (38) on beats 1 and 3 of each bar (i.e. 1,3,5,7...); closed hat (42) on offbeats 0.5,1.5,...; open hat (46) sparingly; toms (41/43/45) as fills in the last bar. Vary velocity for groove.
- After writing, remind the user to press play / trigger the clip to hear it.

Samples and audio files:
- Workflow: search_samples(query) → import_audio_clip (loops/stems onto an audio track's arrangement) or load_sample (one-shots into a Simpler for pitched play).
- search_samples covers the Splice folder if the Splice app is installed and synced, plus Ableton User Library, Factory Packs and Core Library. Splice's online catalog is NOT browsable — only local files.
- search with specific keywords ("deep house loop 124", "909 snare"); if total is huge, refine the query instead of paging.

Swing and groove:
- Live's Groove Pool, .agr files and the global groove amount are NOT reachable via the SDK — never claim you assigned a groove.
- Instead, bake swing into the notes: write_midi_clip / write_session_clip accept a swing parameter (0–100): 0=straight, 30=light MPC bounce, 60=pronounced, 100=full triplet swing. It delays and softens offbeat 16th notes — exactly what a 16th-note groove does. Hats, shakers and basslines benefit most; keep kicks mostly straight.
- When the user asks for "swing" or "groove", write the pattern with swing baked in and say so (e.g. "swing 35 已写进音符").

Controlling instruments and effects (Operator, Auto Filter, …):
- get_song_overview shows each track's devices in chain order. Identify devices by device_index (0-based) or device_name.
- Workflow: get_device_parameters first (use "filter", e.g. "freq" or "lfo" — Operator has 100+ parameters) to learn names, current values, ranges and enum options; then set_device_parameter.
- set_device_parameter accepts fuzzy parameter names ("freq" matches "Frequency") and enum option names as strings.
- Values use the device's own units: Hz for filter frequency, dB for gain, 0–1 for amounts, semitones for pitch. Check min/max before setting.
- Use set_track_mixer for track volume (0–1, 0.85 ≈ 0 dB) and pan (-1 left … 1 right).
- Examples: "把 Auto Filter 的 Frequency 调到 800Hz" → filter "freq" → set; "Operator 的 Coarse 设为 2" → filter "coarse" → set; "把 bass 轨音量降到 0.6" → set_track_mixer.

Compression and sidechain:
- You CAN fully control Compressor parameters: Threshold (-60–0 dB), Ratio, Attack, Release, Makeup gain, Dry/Wet. Typical sidechain-pump settings for techno/house: Ratio 8–20, Attack 0.1–3 ms, Release 100–300 ms, Threshold low enough for 6–10 dB gain reduction per kick hit.
- You CANNOT select the sidechain input source ("Audio From" track) — the SDK has no routing API. Never claim you did it. Instead: insert the Compressor, dial in the pump settings above, then tell the user to finish the last 2 clicks manually: open the Compressor's sidechain section (◁ arrow / headphone icon), enable it, and pick the kick track as "Audio From".
- Send amounts are not controllable either; volume/pan only via set_track_mixer.`;

// ---------- Tool execution against the Live Set ----------

function trackAt(context: Ctx, index: number): Track<"1.0.0"> {
  const tracks = context.application.song.tracks;
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) {
    throw new Error(`轨道序号 ${index} 无效，当前共 ${tracks.length} 条轨道（0 起计）`);
  }
  return tracks[index];
}

function midiTrackAt(context: Ctx, index: number): MidiTrack<"1.0.0"> {
  const track = trackAt(context, index);
  if (!(track instanceof MidiTrack)) {
    throw new Error(`轨道 ${index}（${track.name}）不是 MIDI 轨道`);
  }
  return track;
}

function matchByName<T extends { name: string }>(items: T[], ref: string, what: string): T {
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

function deviceAt(context: Ctx, trackIndex: number, ref: unknown): Device<"1.0.0"> {
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

function paramAt(device: Device<"1.0.0">, ref: unknown): DeviceParameter<"1.0.0"> {
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

async function setParamValue(param: DeviceParameter<"1.0.0">, value: number): Promise<number> {
  const clamped = Math.min(param.max, Math.max(param.min, value));
  await param.setValue(clamped);
  return clamped;
}

function deviceRefFrom(input: Record<string, unknown>): unknown {
  if (typeof input.device_name === "string" && input.device_name.trim()) return input.device_name;
  if (typeof input.device_index === "number") return input.device_index;
  throw new Error("请提供 device_index 或 device_name");
}

function parseNotes(raw: unknown, clipLength: number): NoteDescription[] {
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
function applySwing(notes: NoteDescription[], swingPct: number): NoteDescription[] {
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

async function runTool(
  context: Ctx,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const song = context.application.song;

  switch (name) {
    case "get_song_overview": {
      return {
        tempo: song.tempo,
        scale: song.scaleMode ? song.scaleName : "(scale mode off)",
        tracks: song.tracks.map((t, i) => ({
          index: i,
          name: t.name,
          type: t instanceof MidiTrack ? "MIDI" : "Audio",
          mute: t.mute,
          solo: t.solo,
          arm: t.arm,
          arrangementClips: t.arrangementClips.length,
          devices: t.devices.map((d) => d.name),
        })),
        returnTracks: song.returnTracks.map((t) => t.name),
        scenes: song.scenes.map((s, i) => ({ index: i, name: s.name })),
      };
    }
    case "set_tempo": {
      const bpm = Number(input.bpm);
      if (!(bpm >= 20 && bpm <= 999)) throw new Error("BPM 需在 20–999 之间");
      song.tempo = bpm;
      return { tempo: song.tempo };
    }
    case "create_midi_track": {
      const track = await context.withinTransaction(() => song.createMidiTrack());
      if (input.name) track.name = String(input.name);
      return { created: track.name, type: "MIDI" };
    }
    case "create_audio_track": {
      const track = await context.withinTransaction(() => song.createAudioTrack());
      if (input.name) track.name = String(input.name);
      return { created: track.name, type: "Audio" };
    }
    case "rename_track": {
      const track = trackAt(context, Number(input.index));
      const oldName = track.name;
      track.name = String(input.name);
      return { renamed: oldName, to: track.name };
    }
    case "set_track_state": {
      const track = trackAt(context, Number(input.index));
      if (typeof input.mute === "boolean") track.mute = input.mute;
      if (typeof input.solo === "boolean") track.solo = input.solo;
      if (typeof input.arm === "boolean") track.arm = input.arm;
      return { track: track.name, mute: track.mute, solo: track.solo, arm: track.arm };
    }
    case "insert_device": {
      const track = trackAt(context, Number(input.index));
      const device = await context.withinTransaction(() =>
        track.insertDevice(String(input.device_name), track.devices.length),
      );
      return { inserted: device.name, into: track.name };
    }
    case "create_scene": {
      const index = typeof input.index === "number" ? input.index : -1;
      const scene = await context.withinTransaction(() => song.createScene(index));
      if (input.name) scene.name = String(input.name);
      return { created: scene.name };
    }
    case "get_device_parameters": {
      const device = deviceAt(context, Number(input.track_index), deviceRefFrom(input));
      const filter = typeof input.filter === "string" ? input.filter.toLowerCase() : "";
      const all = await Promise.all(
        device.parameters.map(async (p, i) => {
          if (filter && !p.name.toLowerCase().includes(filter)) return null;
          const value = await p.getValue();
          return {
            index: i,
            name: p.name,
            value,
            min: p.min,
            max: p.max,
            ...(p.isQuantized && p.valueItems.length
              ? { items: p.valueItems.map((v) => v.name) }
              : {}),
          };
        }),
      );
      let params = all.filter((p) => p !== null);
      // Keep tool results small: huge payloads get rejected by some API gateways.
      const cap = filter ? 120 : 40;
      let truncated = false;
      if (params.length > cap) {
        params = params.slice(0, cap);
        truncated = true;
      }
      return {
        device: device.name,
        parameterCount: device.parameters.length,
        ...(truncated
          ? { note: `仅返回前 ${cap} 个参数。请用 filter 按名称精确查询（如 "freq"、"reso"、"coarse"、"lfo"）` }
          : {}),
        parameters: params,
      };
    }
    case "set_device_parameter": {
      const device = deviceAt(context, Number(input.track_index), deviceRefFrom(input));
      const rawParam = String(input.parameter ?? "").trim();
      const param = paramAt(device, /^-?\d+$/.test(rawParam) ? Number(rawParam) : rawParam);

      const rawValue = String(input.value ?? "").trim();
      let value: number;
      if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        value = Number(rawValue);
      } else {
        const q = rawValue.toLowerCase();
        const items = param.valueItems;
        let found = items.findIndex((v) => v.name.toLowerCase() === q);
        if (found < 0) found = items.findIndex((v) => v.name.toLowerCase().includes(q));
        if (found < 0) {
          throw new Error(
            `参数「${param.name}」不接受文本值「${rawValue}」` +
              (items.length ? `。可选：${items.map((v) => v.name).join(", ")}` : "（该参数为数值型）"),
          );
        }
        value = found;
      }
      value = await setParamValue(param, value);
      const display =
        param.isQuantized && param.valueItems[value]
          ? param.valueItems[value].name
          : value;
      return { device: device.name, parameter: param.name, value: display, range: [param.min, param.max] };
    }
    case "set_track_mixer": {
      const track = trackAt(context, Number(input.track_index));
      const out: Record<string, unknown> = { track: track.name };
      if (typeof input.volume !== "undefined") {
        out.volume = await setParamValue(track.mixer.volume, Number(input.volume));
      }
      if (typeof input.pan !== "undefined") {
        out.pan = await setParamValue(track.mixer.panning, Number(input.pan));
      }
      return out;
    }
    case "load_drum_kit": {
      const track = trackAt(context, Number(input.track_index));
      const root = KIT_ROOTS.find((r) => fs.existsSync(r));
      if (!root) {
        throw new Error("找不到 Drum Essentials 音色包（~/Music/Ableton/Factory Packs/Drum Essentials）");
      }
      const missing = KIT_808.filter((p) => !fs.existsSync(path.join(root, p.file)));
      if (missing.length) {
        throw new Error("缺少采样文件: " + missing.map((m) => m.file).join(", "));
      }

      const build = async () => {
        let rack = track.devices.find(
          (d): d is DrumRack<"1.0.0"> => d instanceof DrumRack && d.chains.length === 0,
        );
        if (!rack) {
          rack = (await track.insertDevice("Drum Rack", 0)) as DrumRack<"1.0.0">;
        }
        const pads: string[] = [];
        for (const pad of KIT_808) {
          const chain = (await rack.insertChain(rack.chains.length)) as DrumChain<"1.0.0">;
          chain.receivingNote = pad.note;
          const simpler = (await chain.insertDevice("Simpler", 0)) as Simpler<"1.0.0">;
          await simpler.replaceSample(path.join(root, pad.file));
          pads.push(`${pad.note}=${pad.name}`);
        }
        return pads;
      };
      const pads = await context.withinTransaction(build);
      return { track: track.name, kit: "808", pads };
    }
    case "search_samples": {
      const q = String(input.query ?? "").toLowerCase().trim();
      if (!q) throw new Error("query 不能为空");
      const terms = q.split(/\s+/);
      const matches = buildSampleIndex().filter((p) => {
        const lp = p.toLowerCase();
        return terms.every((t) => lp.includes(t));
      });
      return { total: matches.length, results: matches.slice(0, 30) };
    }
    case "import_audio_clip": {
      const track = trackAt(context, Number(input.track_index));
      if (!(track instanceof AudioTrack)) {
        throw new Error(`轨道 ${input.track_index}（${track.name}）不是音频轨道，先用 create_audio_track 建一条`);
      }
      const filePath = String(input.file_path ?? "");
      if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
      const managed = await context.resources.importIntoProject(filePath);
      const clip = await context.withinTransaction(() =>
        track.createAudioClip({
          filePath: managed,
          startTime: Number(input.start_beat ?? 0),
          ...(typeof input.duration_beats === "number" ? { duration: input.duration_beats } : {}),
          ...(typeof input.warped === "boolean" ? { isWarped: input.warped } : {}),
        }),
      );
      return { clip: clip.name, file: managed };
    }
    case "load_sample": {
      const track = trackAt(context, Number(input.track_index));
      const filePath = String(input.file_path ?? "");
      if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
      const managed = await context.resources.importIntoProject(filePath);
      let simpler = track.devices.find((d): d is Simpler<"1.0.0"> => d instanceof Simpler);
      if (!simpler) {
        simpler = (await context.withinTransaction(() =>
          track.insertDevice("Simpler", 0),
        )) as Simpler<"1.0.0">;
      }
      await simpler.replaceSample(managed);
      return { track: track.name, device: "Simpler", file: managed };
    }
    case "write_midi_clip": {
      const track = midiTrackAt(context, Number(input.track_index));
      const start = Number(input.start_beat ?? 0);
      const length = Number(input.length_beats ?? 16);
      if (!(length > 0)) throw new Error("length_beats 必须大于 0");
      const clip = await context.withinTransaction(() => track.createMidiClip(start, length));
      const notes = applySwing(parseNotes(input.notes, length), Number(input.swing ?? 0)).filter(
        (n) => n.startTime < length,
      );
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return { clip: clip.name, start, length, noteCount: notes.length, swing: Number(input.swing ?? 0) };
    }
    case "write_session_clip": {
      const track = midiTrackAt(context, Number(input.track_index));
      const sceneIndex = Number(input.scene_index);
      const slot = track.clipSlots[sceneIndex];
      if (!slot) throw new Error(`场景序号 ${sceneIndex} 无效`);
      if (slot.clip) throw new Error("该 clip 槽已有 clip，请先删除或换一个槽位");
      const length = Number(input.length_beats ?? 16);
      const clip = await context.withinTransaction(() => slot.createMidiClip(length));
      const notes = applySwing(parseNotes(input.notes, length), Number(input.swing ?? 0)).filter(
        (n) => n.startTime < length,
      );
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return { clip: clip.name, length, noteCount: notes.length, swing: Number(input.swing ?? 0) };
    }
    case "get_clip_notes": {
      const track = trackAt(context, Number(input.track_index));
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      return {
        name: clip.name,
        start: clip.startTime,
        duration: clip.duration,
        notes: clip.notes.map((n) => ({
          pitch: n.pitch,
          start: n.startTime,
          duration: n.duration,
          velocity: n.velocity,
        })),
      };
    }
    case "set_clip_notes": {
      const track = trackAt(context, Number(input.track_index));
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      const notes = parseNotes(input.notes, clip.duration);
      clip.notes = notes;
      return { clip: clip.name, noteCount: notes.length };
    }
    case "rename_scene": {
      const scenes = song.scenes;
      const i = Number(input.index);
      if (!Number.isInteger(i) || i < 0 || i >= scenes.length) {
        throw new Error(`场景序号 ${i} 无效`);
      }
      const oldName = scenes[i].name;
      scenes[i].name = String(input.name);
      return { renamed: oldName, to: scenes[i].name };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// ---------- Claude API with tool-use loop ----------

interface ChatRequest {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ---------- Chat sessions (server-side, persisted) ----------

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; input: unknown; result: unknown }[];
}

/** Whether a chat task is currently running in the background. */
let busy = false;
let lastError: string | null = null;

// ---------- AIbletonBar (native sidebar) window commands ----------
// The modal dialog inside Live can't reach the companion app directly, so its
// "minimize" button queues a command here; AIbletonBar polls and applies it.
let panelCommand: { mode: "bar" | "show"; at: number } | null = null;

// Stamped by esbuild at bundle time (see build.ts); lets AIbletonBar notice
// when the extension has been rebuilt + reloaded and refresh its webview.
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

/** Append a line to ai-debug.log next to chats.json — for diagnosing background tasks. */
function debugLog(context: Ctx, line: string) {
  try {
    const file = path.join(path.dirname(storeFilePath(context)), "ai-debug.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Best-effort logging.
  }
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: HistoryMessage[];
}

let sessions: ChatSession[] = [];
let currentId: string | null = null;

/** Set when the SDK storage dir turns out to be missing/unwritable. */
let storeFileOverride: string | null = null;

function fallbackStorePath(): string {
  return path.join(os.homedir(), "Library", "Application Support", "AIbleton", "chats.json");
}

function storeFilePath(context: Ctx): string {
  if (storeFileOverride) return storeFileOverride;
  const dir = context.environment.storageDirectory;
  // The beta may return undefined for storageDirectory — fall back to a
  // stable per-user location so sessions actually persist.
  return dir ? path.join(dir, "chats.json") : fallbackStorePath();
}

function createSession(): ChatSession {
  const session: ChatSession = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  sessions.unshift(session);
  currentId = session.id;
  return session;
}

function currentSession(): ChatSession {
  return sessions.find((s) => s.id === currentId) ?? createSession();
}

function loadStore(context: Ctx) {
  const candidates = [...new Set([storeFilePath(context), fallbackStorePath()])];
  let loadedFrom: string | null = null;
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        sessions?: ChatSession[];
        currentId?: string;
      };
      if (Array.isArray(data.sessions)) {
        sessions = data.sessions.filter(
          (s) => s && typeof s.id === "string" && Array.isArray(s.messages),
        );
        currentId = typeof data.currentId === "string" ? data.currentId : (sessions[0]?.id ?? null);
        loadedFrom = file;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  // Migrate the previous single-file history, if any.
  if (sessions.length === 0) {
    for (const file of candidates) {
      try {
        const legacy = JSON.parse(
          fs.readFileSync(path.join(path.dirname(file), "chat-history.json"), "utf8"),
        ) as unknown;
        if (Array.isArray(legacy) && legacy.length) {
          const session = createSession();
          session.messages = legacy.filter(
            (m): m is HistoryMessage =>
              !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          );
          const first = session.messages.find((m) => m.role === "user");
          session.title = first ? first.content.slice(0, 24) : "导入的对话";
          break;
        }
      } catch {
        // Nothing to migrate here.
      }
    }
  }
  console.log(`[ai-assistant] 会话存储: ${loadedFrom ?? storeFilePath(context)}`);
}

function saveStore(context: Ctx) {
  const file = storeFilePath(context);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions, currentId }));
  } catch {
    // Primary location unwritable — switch permanently to the fallback.
    const fallback = fallbackStorePath();
    if (file !== fallback) {
      storeFileOverride = fallback;
      try {
        fs.mkdirSync(path.dirname(fallback), { recursive: true });
        fs.writeFileSync(fallback, JSON.stringify({ sessions, currentId }));
        console.log(`[ai-assistant] 会话存储回退到: ${fallback}`);
      } catch {
        // In-memory sessions still work for this run.
      }
    }
  }
}

function resolveConfig(req: ChatRequest) {
  const local = loadClaudeCodeConfig() ?? {};
  const baseUrl = (
    req.baseUrl || local.baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
  ).replace(/\/$/, "");
  const authToken = req.apiKey || local.authToken || local.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
  const model = req.model || local.model || "claude-sonnet-5";
  return { baseUrl, authToken, model, fromLocal: !req.apiKey && Boolean(local.authToken || local.apiKey) };
}

async function chat(context: Ctx, req: ChatRequest) {
  const { baseUrl, authToken, model } = resolveConfig(req);
  if (!authToken) {
    throw new Error("未找到认证信息：请在 ~/.claude/settings.json 配置，或在对话框顶部填入 API Key");
  }

  const session = currentSession();
  const messages: unknown[] = session.messages.map((m) => ({ role: m.role, content: m.content }));
  const actions: { tool: string; input: unknown; result: unknown }[] = [];

  for (let round = 0; round < 12; round++) {
    // Mirror Claude Code's auth style: Bearer token (works for relays and OAuth),
    // plus x-api-key for endpoints that expect it.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${authToken}`,
      "x-api-key": authToken,
    };
    if (authToken.startsWith("sk-ant-oat")) {
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    const requestBody = JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: requestBody,
    });
    const data = (await res.json()) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      stop_reason?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      console.error(
        `[ai-assistant] API ${res.status} · 请求 ${requestBody.length} 字符 · ` +
          `messages=${messages.length} tools=${TOOLS.length} · 响应: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw new Error(data.error?.message || `Claude API 错误 (${res.status})`);
    }

    const content = data.content ?? [];
    messages.push({ role: "assistant", content });
    debugLog(
      context,
      `ROUND ${round}: stop_reason=${data.stop_reason} blocks=${content.map((b) => b.type).join(",")}`,
    );

    if (data.stop_reason !== "tool_use") {
      const reply =
        content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim() || "（无文本回复）";
      session.messages.push({ role: "assistant", content: reply, actions });
      session.updatedAt = Date.now();
      saveStore(context);
      return { reply, actions };
    }

    const toolResults: unknown[] = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      let result: unknown;
      try {
        result = await runTool(context, block.name!, block.input ?? {});
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      actions.push({ tool: block.name!, input: block.input, result });
      let resultJson = JSON.stringify(result);
      debugLog(context, `TOOL ${block.name} ${JSON.stringify(block.input)} -> ${resultJson.slice(0, 400)}`);
      if (resultJson.length > 6000) {
        resultJson =
          resultJson.slice(0, 6000) +
          `…（结果过大已截断，共 ${resultJson.length} 字符。请用 filter 缩小查询范围）`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultJson,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  throw new Error("工具调用次数过多，已中止");
}

// ---------- HTTP server ----------

export function startServer(context: Ctx): Promise<{ url: string; port: number }> {
  // Set once listening; lets /api/open pop the dialog from outside Live
  // (e.g. a global hotkey triggering `curl http://localhost:17666/api/open`).
  let selfUrl = "";

  const server = http.createServer((req, res) => {
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
      res.end(body);
    };

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      send(200, chatInterface, "text/html");
      return;
    }
    if (req.method === "GET" && req.url === "/api/health") {
      const cfg = resolveConfig({});
      send(200, JSON.stringify({
        ok: true,
        hasAuth: Boolean(cfg.authToken),
        baseUrl: cfg.baseUrl,
        model: cfg.model,
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/open") {
      if (selfUrl) {
        void context.ui.showModalDialog(selfUrl, 560, 680).catch(() => {});
      }
      send(200, JSON.stringify({ ok: Boolean(selfUrl) }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/history") {
      send(200, JSON.stringify({ messages: currentSession().messages }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      send(200, JSON.stringify({
        currentId: currentSession().id,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        })),
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/new") {
      const session = createSession();
      saveStore(context);
      send(200, JSON.stringify({ id: session.id }));
      return;
    }
    const readBody = (cb: (parsed: Record<string, unknown>) => void) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          cb(body ? (JSON.parse(body) as Record<string, unknown>) : {});
        } catch (err) {
          send(400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    };
    if (req.method === "POST" && req.url === "/api/switch") {
      readBody((parsed) => {
        const target = sessions.find((s) => s.id === parsed.id);
        if (!target) {
          send(404, JSON.stringify({ error: "会话不存在" }));
          return;
        }
        currentId = target.id;
        saveStore(context);
        send(200, JSON.stringify({ messages: target.messages }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/delete") {
      readBody((parsed) => {
        sessions = sessions.filter((s) => s.id !== parsed.id);
        if (currentId === parsed.id) currentId = sessions[0]?.id ?? null;
        saveStore(context);
        send(200, JSON.stringify({ messages: currentSession().messages }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/status") {
      send(200, JSON.stringify({ busy, error: lastError }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/panel") {
      readBody((parsed) => {
        const mode = parsed.mode === "bar" || parsed.mode === "show" ? parsed.mode : null;
        panelCommand = mode ? { mode, at: Date.now() } : null;
        send(mode ? 200 : 400, JSON.stringify({ ok: Boolean(mode) }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/panel") {
      // Commands expire quickly — a stale "bar" from hours ago shouldn't
      // pop the mini bar the next time AIbletonBar launches.
      const fresh = panelCommand && Date.now() - panelCommand.at < 60_000 ? panelCommand : null;
      panelCommand = null;
      send(200, JSON.stringify({ mode: fresh?.mode ?? null, build: BUILD_ID }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      readBody((parsed) => {
        const text = String(parsed.text ?? "").trim();
        if (!text) {
          send(400, JSON.stringify({ error: "消息不能为空" }));
          return;
        }
        if (busy) {
          send(409, JSON.stringify({ error: "上一个任务还在进行中，请稍候" }));
          return;
        }
        const session = currentSession();
        session.messages.push({ role: "user", content: text });
        if (session.title === "新对话") session.title = text.slice(0, 24);
        session.updatedAt = Date.now();
        saveStore(context);
        busy = true;
        lastError = null;
        // Respond immediately: the task runs in the background on the extension
        // side, so closing the dialog (which kills this connection) does NOT
        // stop it. Clients poll /api/status and then read /api/history.
        send(202, JSON.stringify({ ok: true }));
        debugLog(context, `TASK start: "${text.slice(0, 60)}"`);
        void (async () => {
          try {
            await chat(context, parsed);
            debugLog(context, "TASK done");
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            debugLog(context, `TASK error: ${lastError}`);
            session.messages.pop(); // roll back the user message to keep the conversation consistent
            saveStore(context);
          } finally {
            busy = false;
          }
        })();
      });
      return;
    }
    send(404, JSON.stringify({ error: "not found" }));
  });

  // Fixed port keeps the URL stable so the same assistant can also be opened
  // in a regular browser alongside Live; fall back to a random port if taken.
  const PREFERRED_PORT = 17666;
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once("error", (err) => {
        if (port !== 0) tryListen(0);
        else reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          selfUrl = `http://localhost:${addr.port}/`;
          resolve({ url: selfUrl, port: addr.port });
        } else {
          reject(new Error("无法启动本地服务"));
        }
      });
    };
    loadStore(context);
    tryListen(PREFERRED_PORT);
  });
}
