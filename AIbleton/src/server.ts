import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The Live extension sandbox does NOT expose Node's usual globals — URL and
// Buffer must be imported explicitly (a bare `new URL()` crashes the process
// with ReferenceError inside request handlers).
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { describeBinaryAttachment } from "./fileparsers.js";
import {
  AUDIO_EXT,
  detectSystemProxy,
  kitRoots,
  listAudioFilesViaFind,
  mkdirOutsideSandbox,
  pathExists,
  readHomeFile,
  resolveAbletonLibraryPaths,
  sampleRoots,
  storeFallbackPath,
  writeHomeBinary,
  writeHomeFile,
} from "./paths.js";
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

let sampleIndex: string[] | null = null;

function buildSampleIndex(): string[] {
  if (sampleIndex) return sampleIndex;
  const roots = sampleRoots();
  const out: string[] = [];
  for (const root of roots) {
    if (out.length >= 200000) break;
    // Direct recursive walk; if the sandbox denies the root itself, fall back
    // to /usr/bin/find for that root (same child-process escape as the fs
    // primitives in paths.ts).
    let denied = false;
    const stack = [root];
    const fromRoot: string[] = [];
    while (stack.length && out.length + fromRoot.length < 200000) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_ACCESS_DENIED" && dir === root) {
          denied = true;
          break;
        }
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) fromRoot.push(full);
      }
    }
    out.push(...(denied ? listAudioFilesViaFind(root, 200000 - out.length) : fromRoot));
  }
  sampleIndex = out;
  console.log(`[ai-assistant] 采样索引: ${out.length} 个文件，来源: ${roots.join(" | ")}`);
  return out;
}

// ---------- Factory 808 drum kit (Drum Essentials pack) ----------

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

// ---------- Local CLI configs (Claude Code / Codex / Gemini) ----------

type Provider = "claude" | "codex" | "gemini";

const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

interface LocalConfig {
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  model?: string;
  /** Codex ChatGPT-account mode: JWT for chatgpt.com/backend-api/codex. */
  accountId?: string;
  refreshToken?: string;
  chatgpt?: boolean;
  reasoningEffort?: string;
}

const configCache: Partial<Record<Provider, LocalConfig | null>> = {};

function loadClaudeCodeConfig(): LocalConfig | null {
  if ("claude" in configCache) return configCache.claude ?? null;
  const raw = readHomeFile(path.join(os.homedir(), ".claude", "settings.json"));
  if (raw) {
    try {
      const settings = JSON.parse(raw) as {
        env?: Record<string, string>;
        model?: string;
      };
      const env = settings.env ?? {};
      configCache.claude = {
        baseUrl: env.ANTHROPIC_BASE_URL,
        authToken: env.ANTHROPIC_AUTH_TOKEN,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL || settings.model,
      };
    } catch {
      configCache.claude = null;
    }
  } else {
    configCache.claude = null;
  }
  return configCache.claude ?? null;
}

/**
 * Codex CLI: ~/.codex/auth.json holds either OPENAI_API_KEY (API-key mode) or
 * ChatGPT OAuth tokens (subscription mode — access_token is a JWT for the
 * chatgpt.com backend, refreshable via refresh_token). Model and reasoning
 * effort come from ~/.codex/config.toml.
 */
function loadCodexConfig(): LocalConfig | null {
  if ("codex" in configCache) return configCache.codex ?? null;
  let apiKey: string | undefined;
  let accessToken: string | undefined;
  let accountId: string | undefined;
  let refreshToken: string | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  const authRaw = readHomeFile(path.join(os.homedir(), ".codex", "auth.json"));
  if (authRaw) {
    try {
      const auth = JSON.parse(authRaw) as {
        OPENAI_API_KEY?: string | null;
        tokens?: { access_token?: string; account_id?: string; refresh_token?: string };
      };
      if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
        apiKey = auth.OPENAI_API_KEY;
      }
      accessToken = auth.tokens?.access_token || undefined;
      accountId = auth.tokens?.account_id || undefined;
      refreshToken = auth.tokens?.refresh_token || undefined;
    } catch {
      // Unparseable auth.json — fall through to env vars at resolve time.
    }
  }
  const toml = readHomeFile(path.join(os.homedir(), ".codex", "config.toml"));
  if (toml) {
    const m = /^model\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) model = m[1];
    const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml);
    if (effort) reasoningEffort = effort[1];
  }
  const hasAuth = Boolean(apiKey || accessToken || refreshToken);
  configCache.codex = hasAuth || model
    ? {
        apiKey,
        authToken: accessToken,
        accountId,
        refreshToken,
        model,
        reasoningEffort,
        chatgpt: !apiKey && Boolean(accessToken || refreshToken),
      }
    : null;
  return configCache.codex;
}

/** Gemini CLI: API key in ~/.gemini/.env (GEMINI_API_KEY=…), env vars win. */
function loadGeminiConfig(): LocalConfig | null {
  if ("gemini" in configCache) return configCache.gemini ?? null;
  let apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
  if (!apiKey) {
    const envFile = readHomeFile(path.join(os.homedir(), ".gemini", ".env"));
    if (envFile) {
      const m = /^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*"?([^"\r\n]+)"?/m.exec(envFile);
      if (m) apiKey = m[1].trim();
    }
  }
  configCache.gemini = apiKey ? { apiKey } : null;
  return configCache.gemini;
}

function loadLocalConfig(provider: Provider): LocalConfig | null {
  if (provider === "codex") return loadCodexConfig();
  if (provider === "gemini") return loadGeminiConfig();
  return loadClaudeCodeConfig();
}

/**
 * Manual provider config from the settings UI, persisted as providers.json in
 * the extension's storage directory. Resolution order per field:
 * per-request override > manual > CLI autodetect > env. CLI autodetect reads
 * ~/.claude / ~/.codex / ~/.gemini — inside the installed Extension Host that
 * only works through readHomeFile's child-process fallback, so a manual
 * config remains the reliable last resort there.
 */
let manualConfigs: Partial<Record<Provider, LocalConfig>> = {};
let manualConfigPath: string | null = null;

function loadManualConfigs(context: Ctx): void {
  // Same directory as chats.json (storage dir, or the fallback it picked).
  const dir = storeFileOverride
    ? path.dirname(storeFileOverride)
    : context.environment.storageDirectory || path.dirname(storeFallbackPath());
  manualConfigPath = path.join(dir, "providers.json");
  try {
    const raw = readHomeFile(manualConfigPath);
    if (!raw) throw new Error("unreadable");
    const data = JSON.parse(raw) as
      Partial<Record<Provider, LocalConfig>>;
    manualConfigs = {};
    for (const p of ["claude", "codex", "gemini"] as Provider[]) {
      const cfg = data[p];
      if (cfg && typeof cfg === "object") manualConfigs[p] = cfg;
    }
  } catch {
    manualConfigs = {};
  }
  const configured = Object.keys(manualConfigs).join(", ");
  console.log(`[ai-assistant] Provider 手动配置: ${configured || "无"}`);
}

function saveManualConfigs(): void {
  if (!manualConfigPath) return;
  try {
    mkdirOutsideSandbox(path.dirname(manualConfigPath));
    writeHomeFile(manualConfigPath, JSON.stringify(manualConfigs, null, 2));
  } catch {
    // In-memory copy still works for this run.
  }
}

type Ctx = ExtensionContext<"1.0.0">;

// ---------- Audio-generation providers ----------

type AudioProvider = "stable-audio";

const AUDIO_PROVIDER_NAMES: Record<AudioProvider, string> = {
  "stable-audio": "Stable Audio",
};

interface AudioGenConfig {
  provider: AudioProvider;
  apiKey: string;
  baseUrl: string;
}

/**
 * Audio-generator config for the running chat task. Rides the chat request
 * (same per-request override pattern as the chat provider keys) and is
 * resolved once per /api/chat — `busy` guarantees a single task at a time.
 */
let activeAudioConfig: AudioGenConfig | null = null;

function resolveAudioConfig(req: ChatRequest): AudioGenConfig | null {
  // Only one provider so far; req.audio.provider is reserved for the switcher.
  const provider: AudioProvider = "stable-audio";
  const apiKey = req.audio?.apiKey || process.env.STABILITY_API_KEY || "";
  if (!apiKey) return null;
  const baseUrl = (req.audio?.baseUrl || "https://api.stability.ai").replace(/\/$/, "");
  return { provider, apiKey, baseUrl };
}

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
    name: "generate_audio",
    description:
      "Generate NEW audio with an AI music model (Stable Audio) and save it into the User Library's 'AIbleton' folder. Costs API credits and takes ~10–60 s. Returns the saved file path — then call import_audio_clip (loops onto an audio track's arrangement) or load_sample (one-shots into a Simpler).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "English, specific: genre, BPM, key, instrumentation, mood. Add 'seamless loop' for loops.",
        },
        duration_seconds: { type: "number", description: "1–190 (default 8); use 4–16 for loops" },
      },
      required: ["prompt"],
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
- Reply in the same language the user writes in (default: English).
- Be concise and practical. No fluff.
- Before calling tools that modify the Set, briefly say what you are about to do.
- Track indices are 0-based, matching get_song_overview output. Call get_song_overview first whenever you need current track/scene info.
- You CAN adjust device parameters (Operator, Reverb, Auto Filter, …) and track volume/pan — see the device-control section below.
- You cannot delete anything, load third-party plugins, or do realtime audio/MIDI processing. Say so if asked.
- After tools run, confirm what changed in one short sentence.
- NEVER claim you changed the Live Set unless a tool actually performed the change in THIS turn. If you did not call a tool, nothing changed — do not pretend otherwise.

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

AI audio generation:
- generate_audio(prompt, duration_seconds) creates NEW audio with Stable Audio and saves it into the User Library's "AIbleton" folder. It costs API credits and takes ~10–60 s — write a precise English prompt (genre, BPM, key, mood; add "seamless loop" for loops) and keep loops short (4–16 s).
- Workflow: generate_audio → import_audio_clip (loops/stems onto an audio track) or load_sample (one-shots into a Simpler). Generated files also become searchable via search_samples afterwards.
- If the tool errors about a missing API key, tell the user to add their Stability key in Settings (gear icon) → 音频生成 / Audio Generation.

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
      const roots = kitRoots();
      const root = roots.find((r) => pathExists(r));
      if (!root) {
        throw new Error("找不到 Drum Essentials 音色包（已检查: " + roots.join(" | ") + "）");
      }
      const missing = KIT_808.filter((p) => !pathExists(path.join(root, p.file)));
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
      if (!pathExists(filePath)) throw new Error(`文件不存在: ${filePath}`);
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
      if (!pathExists(filePath)) throw new Error(`文件不存在: ${filePath}`);
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
    case "generate_audio": {
      const cfg = activeAudioConfig;
      if (!cfg) {
        throw new Error(
          `未配置音频生成 API Key:设置(齿轮)→ 音频生成 里填 ${AUDIO_PROVIDER_NAMES["stable-audio"]} 的 key,或设环境变量 STABILITY_API_KEY`,
        );
      }
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const duration = Math.min(190, Math.max(1, Number(input.duration_seconds ?? 8) || 8));
      const file = await generateStableAudio(cfg, prompt, duration);
      // Let search_samples find the new file without a restart.
      sampleIndex = null;
      return {
        file,
        duration_seconds: duration,
        next: "用 import_audio_clip 放上编排(loop/stem)或 load_sample 装进 Simpler(one-shot)",
      };
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

/**
 * A file the user attached in the UI: text content (text), base64 image
 * (data), or a binary music file (kind + data) that gets parsed into a text
 * summary before reaching the model.
 */
interface Attachment {
  name: string;
  mime: string;
  text?: string;
  data?: string;
  /** "midi" | "als" — binary music files parsed by fileparsers.ts. */
  kind?: string;
}

interface ChatRequest {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  /** Reasoning effort override: "low" | "medium" | "high" (empty = provider default). */
  effort?: string;
  /** false = ask the user before any Set-modifying tool call (default true = run freely). */
  yolo?: boolean;
  attachments?: Attachment[];
  /** Audio-generation provider config from the settings UI (same per-request pattern as apiKey). */
  audio?: { provider?: string; apiKey?: string; baseUrl?: string };
}

interface ResolvedConfig {
  provider: Provider;
  baseUrl: string;
  authToken: string;
  model: string;
  fromLocal: boolean;
  /** Codex ChatGPT-account mode. */
  accountId?: string;
  refreshToken?: string;
  chatgpt?: boolean;
  reasoningEffort?: string;
  /** UI-selected effort, mapped per provider (claude: thinking budget; gemini: thinkingBudget). */
  effort?: string;
}

/** UI language → reply language injected into the system prompt. */
const LANG_NAMES: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  de: "German",
  fr: "French",
  ja: "Japanese",
  es: "Spanish",
  it: "Italian",
};

function systemPromptFor(language?: string): string {
  const name = LANG_NAMES[language ?? ""] ?? "English";
  return (
    SYSTEM_PROMPT +
    `\n\nThe user's UI language is ${name} — use it as the default reply language unless they write in a different language.`
  );
}

const NO_AUTH_HINT: Record<string, string> = {
  zh: "未找到 {p} 认证信息：请在设置（齿轮图标）里填 API Key，或配置本机 CLI",
  en: "No {p} credentials found: add an API Key in Settings (gear icon) or set up the local CLI",
  de: "Keine {p}-Zugangsdaten gefunden: API-Schlüssel in den Einstellungen (Zahnrad) eintragen oder lokale CLI konfigurieren",
  fr: "Aucun identifiant {p} : ajoutez une clé API dans les paramètres (icône engrenage) ou configurez la CLI locale",
  ja: "{p} の認証情報がありません：設定（歯車アイコン）で API キーを入力するか、ローカル CLI を設定してください",
  es: "Sin credenciales de {p}: añade una API Key en Ajustes (icono de engranaje) o configura la CLI local",
  it: "Nessuna credenziale {p}: aggiungi una API Key nelle Impostazioni (icona ingranaggio) o configura la CLI locale",
};

/** Assistant note recorded when the user stops a task from the UI. */
const STOP_NOTE: Record<string, string> = {
  zh: "⏹ 已手动停止",
  en: "⏹ Stopped manually",
  de: "⏹ Manuell gestoppt",
  fr: "⏹ Arrêté manuellement",
  ja: "⏹ 手動で停止しました",
  es: "⏹ Detenido manualmente",
  it: "⏹ Interrotto manualmente",
};

function stopNote(language?: string): string {
  return STOP_NOTE[language ?? ""] ?? STOP_NOTE.en;
}

/** Appended to a reply that stayed truncated after all auto-continuations. */
const TRUNC_NOTE: Record<string, string> = {
  zh: "（回复超出长度限制被截断，发送「继续」可补全）",
  en: "(Reply hit the token limit and was cut off — send “continue” to finish it.)",
  de: "(Antwort am Token-Limit abgeschnitten — sende „weiter“ zum Fortsetzen.)",
  fr: "(Réponse tronquée par la limite de tokens — envoyez « continuer » pour la terminer.)",
  ja: "（トークン上限で途中で切れました —「続けて」と送信すると続きます）",
  es: "(Respuesta cortada por el límite de tokens — envía «continuar» para completarla.)",
  it: "(Risposta troncata dal limite di token — invia «continua» per completarla.)",
};

// ---------- Chat sessions (server-side, persisted) ----------

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; input: unknown; result: unknown }[];
}

/** Whether a chat task is currently running in the background. */
let busy = false;
let lastError: string | null = null;

/** Set by /api/stop: the running task aborts its in-flight request and exits. */
let stopRequested = false;
let abortCtl: AbortController | null = null;

// ---------- AIbletonBar (native sidebar) window commands ----------
// The modal dialog inside Live can't reach the companion app directly, so its
// "minimize" button queues a command here; AIbletonBar polls and applies it.
let panelCommand: { mode: "bar" | "show"; at: number } | null = null;

// Stamped by esbuild at bundle time (see build.ts); lets AIbletonBar notice
// when the extension has been rebuilt + reloaded and refresh its webview.
declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

// Stamped by esbuild from package.json; injected into the served page so the
// settings view can show the real version (and users can confirm the reload).
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

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

function storeFilePath(context: Ctx): string {
  if (storeFileOverride) return storeFileOverride;
  const dir = context.environment.storageDirectory;
  // The beta may return undefined for storageDirectory — fall back to a
  // stable per-user location so sessions actually persist.
  return dir ? path.join(dir, "chats.json") : storeFallbackPath();
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
  const candidates = [...new Set([storeFilePath(context), storeFallbackPath()])];
  let loadedFrom: string | null = null;
  for (const file of candidates) {
    try {
      const raw = readHomeFile(file);
      if (!raw) continue;
      const data = JSON.parse(raw) as {
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
        const legacyRaw = readHomeFile(path.join(path.dirname(file), "chat-history.json"));
        if (!legacyRaw) continue;
        const legacy = JSON.parse(legacyRaw) as unknown;
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
    return;
  } catch {
    // Primary location unwritable — fall through to the home fallback, reached
    // via the same child-process escape as readHomeFile/writeHomeFile.
  }
  const fallback = storeFallbackPath();
  if (file !== fallback) storeFileOverride = fallback;
  try {
    mkdirOutsideSandbox(path.dirname(fallback));
    writeHomeFile(fallback, JSON.stringify({ sessions, currentId }));
    if (file !== fallback) console.log(`[ai-assistant] 会话存储回退到: ${fallback}`);
  } catch {
    // In-memory sessions still work for this run.
  }
}

function resolveConfig(req: ChatRequest): ResolvedConfig {
  const provider: Provider =
    req.provider === "codex" || req.provider === "gemini" ? req.provider : "claude";
  // Manual settings-UI config wins over CLI autodetect; per-request fields win over both.
  const local: LocalConfig = { ...(loadLocalConfig(provider) ?? {}), ...(manualConfigs[provider] ?? {}) };
  const fromLocal = !req.apiKey && Boolean(local.authToken || local.apiKey);

  if (provider === "codex") {
    // ChatGPT-account tokens only work against the chatgpt.com backend;
    // plain API keys go to api.openai.com (or a user-supplied relay).
    const chatgpt =
      !req.apiKey && !req.baseUrl && !local.apiKey &&
      Boolean(local.chatgpt || local.authToken || local.refreshToken);
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || process.env.OPENAI_BASE_URL ||
        (chatgpt ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1")).replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || local.authToken || process.env.OPENAI_API_KEY || "",
      model: req.model || local.model || "gpt-5-codex",
      fromLocal,
      accountId: chatgpt ? local.accountId : undefined,
      refreshToken: chatgpt ? local.refreshToken : undefined,
      chatgpt,
      // UI effort selector wins over the CLI config file.
      reasoningEffort: req.effort || local.reasoningEffort,
      effort: req.effort,
    };
  }
  if (provider === "gemini") {
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
      model: req.model || local.model || "gemini-2.5-pro",
      fromLocal,
      effort: req.effort,
    };
  }
  return {
    provider,
    baseUrl: (req.baseUrl || local.baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    authToken: req.apiKey || local.authToken || local.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
    model: req.model || local.model || "claude-sonnet-5",
    fromLocal,
    effort: req.effort,
  };
}

/** Shared tail of a completed chat: persist the assistant reply + tool actions. */
function finishChat(
  context: Ctx,
  actions: { tool: string; input: unknown; result: unknown }[],
  reply: string,
) {
  const session = currentSession();
  session.messages.push({ role: "assistant", content: reply, actions });
  session.updatedAt = Date.now();
  saveStore(context);
  return { reply, actions };
}

/** Cap a tool-result payload the same way for live calls and history replay. */
function truncateResult(resultJson: string): string {
  if (resultJson.length <= 6000) return resultJson;
  return (
    resultJson.slice(0, 6000) +
    `…（结果过大已截断，共 ${resultJson.length} 字符。请用 filter 缩小查询范围）`
  );
}

/** Tools that only read the Set — always allowed, even with YOLO off. */
const READ_ONLY_TOOLS = new Set([
  "get_song_overview",
  "get_device_parameters",
  "get_clip_notes",
  "search_samples",
]);

/**
 * A tool call waiting for the user's Allow/Deny click in the UI (YOLO off).
 * The UI polls /api/status for it and answers via POST /api/confirm.
 */
let pendingConfirm: {
  tool: string;
  input: unknown;
  resolve: (allow: boolean) => void;
} | null = null;

/** Ask the user before a Set-modifying tool call; false = denied or timed out. */
function askConfirmation(tool: string, input: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    // Safety net: a forgotten dialog must not wedge the background task forever.
    const timer = setTimeout(() => {
      pendingConfirm = null;
      resolve(false);
    }, 300_000);
    pendingConfirm = {
      tool,
      input,
      resolve: (allow) => {
        clearTimeout(timer);
        pendingConfirm = null;
        resolve(allow);
      },
    };
  });
}

/** Run one tool call and normalize the result for the provider + UI log. */
async function callTool(
  context: Ctx,
  actions: { tool: string; input: unknown; result: unknown }[],
  name: string,
  input: Record<string, unknown>,
  yolo: boolean,
): Promise<string> {
  if (!yolo && !READ_ONLY_TOOLS.has(name)) {
    const allowed = await askConfirmation(name, input);
    if (!allowed) {
      const denied = { error: "用户拒绝了该操作 / user denied this action" };
      actions.push({ tool: name, input, result: denied });
      debugLog(context, `TOOL ${name} DENIED by user`);
      return JSON.stringify(denied);
    }
  }
  let result: unknown;
  try {
    result = await runTool(context, name, input);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  actions.push({ tool: name, input, result });
  const resultJson = JSON.stringify(result);
  debugLog(context, `TOOL ${name} ${JSON.stringify(input)} -> ${resultJson.slice(0, 400)}`);
  return truncateResult(resultJson);
}

/**
 * Replay stored messages WITH their tool rounds reconstructed.
 * Weaker models imitate history: if past assistant turns claim "done" with no
 * visible tool calls, the model learns to pretend instead of calling tools.
 * Re-inserting the tool-call/tool-result structure keeps it honest.
 */
function historyWithTools(
  session: ChatSession,
  format: {
    userText: (text: string) => unknown;
    assistantText: (text: string) => unknown;
    /** Message items replaying one assistant turn's tool calls (id prefix given). */
    toolRound: (acts: { tool: string; input: unknown; result: unknown }[], idPrefix: string) => unknown[];
  },
): unknown[] {
  const out: unknown[] = [];
  session.messages.forEach((m, mi) => {
    if (m.role === "user") {
      out.push(format.userText(m.content));
      return;
    }
    const acts = m.actions ?? [];
    if (acts.length) out.push(...format.toolRound(acts, `hist_${mi}_`));
    out.push(format.assistantText(m.content));
  });
  return out;
}

/**
 * Attached images ride only on the CURRENT user message (the last one after
 * history replay). Older turns keep just their "[图片: name]" text marker —
 * re-sending base64 on every round would bloat each request. The `apply`
 * callback reshapes that last message into the provider's multimodal shape.
 */
function attachImages(
  messages: unknown[],
  req: ChatRequest,
  apply: (last: Record<string, unknown>, images: Attachment[]) => void,
) {
  const images = (req.attachments ?? []).filter((a) => typeof a.data === "string" && a.data && !a.kind);
  if (!images.length) return;
  const last = messages[messages.length - 1] as (Record<string, unknown> & { role?: string }) | undefined;
  if (!last || last.role !== "user") return;
  apply(last, images);
}

/** Codex CLI's public OAuth client id (the same one codex-cli-rs uses). */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function jwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp : null;
  } catch {
    return null;
  }
}

/** Refresh an expired ChatGPT-account Codex token and persist it back to auth.json. */
async function refreshCodexToken(cfg: ResolvedConfig): Promise<void> {
  const fail = new Error("Codex 登录已过期，请运行 codex login 重新登录 / Codex login expired — run `codex login` again");
  if (!cfg.refreshToken) throw fail;
  const res = await rawPost(new URL("https://auth.openai.com/oauth/token"), {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
    }),
    proxy: detectProxy(),
  }).catch(() => null);
  const data =
    res && res.status >= 200 && res.status < 300
      ? (JSON.parse(await readAll(res.stream)) as { access_token?: string; refresh_token?: string; id_token?: string })
      : null;
  if (!data?.access_token) throw fail;
  cfg.authToken = data.access_token;
  if (data.refresh_token) cfg.refreshToken = data.refresh_token;
  // Update the manual store too: providers.json lives in the always-writable
  // storage dir, so refreshed tokens survive even if the write-back to
  // ~/.codex fails (installed sandbox without the child-process fallback).
  const manual = manualConfigs.codex;
  if (manual?.refreshToken) {
    manual.authToken = data.access_token;
    if (data.refresh_token) manual.refreshToken = data.refresh_token;
    saveManualConfigs();
  }
  // Persist back, mirroring what codex CLI does (best effort — writeHomeFile
  // routes around the installed sandbox's fs-write restriction via tee).
  try {
    const file = path.join(os.homedir(), ".codex", "auth.json");
    const raw = readHomeFile(file);
    if (!raw) throw new Error("auth.json unreadable");
    const cur = JSON.parse(raw) as {
      tokens?: Record<string, unknown>;
      last_refresh?: string;
    };
    cur.tokens = {
      ...(cur.tokens ?? {}),
      access_token: data.access_token,
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
      ...(data.id_token ? { id_token: data.id_token } : {}),
    };
    cur.last_refresh = new Date().toISOString();
    writeHomeFile(file, JSON.stringify(cur, null, 2));
    if (configCache.codex) {
      configCache.codex.authToken = data.access_token;
      if (data.refresh_token) configCache.codex.refreshToken = data.refresh_token;
    }
  } catch {
    // The in-memory token still works for this run.
  }
}

/** Proactively refresh a ChatGPT-account Codex token when it is about to expire. */
async function ensureCodexAuth(cfg: ResolvedConfig): Promise<void> {
  if (!cfg.chatgpt) return;
  const exp = cfg.authToken ? jwtExp(cfg.authToken) : null;
  if (exp && exp - Date.now() / 1000 > 120) return; // still valid
  if (exp) await refreshCodexToken(cfg); // expired — refresh before the call
  // No readable exp (opaque token): proceed; a 401 triggers the refresh retry.
}

async function chat(context: Ctx, req: ChatRequest) {
  const cfg = resolveConfig(req);
  if (!cfg.authToken && !cfg.refreshToken) {
    const hint = NO_AUTH_HINT[req.language ?? ""] ?? NO_AUTH_HINT.en;
    throw new Error(hint.replace("{p}", PROVIDER_NAMES[cfg.provider]));
  }
  if (cfg.provider === "codex") {
    await ensureCodexAuth(cfg);
    return chatOpenAI(context, cfg, req);
  }
  if (cfg.provider === "gemini") return chatGemini(context, cfg, req);
  return chatAnthropic(context, cfg, req);
}

async function chatAnthropic(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
  const { baseUrl, authToken, model } = cfg;
  const messages: unknown[] = historyWithTools(currentSession(), {
    userText: (text) => ({ role: "user", content: text }),
    assistantText: (text) => ({ role: "assistant", content: text }),
    toolRound: (acts, p) => [
      {
        role: "assistant",
        content: acts.map((a, i) => ({ type: "tool_use", id: p + i, name: a.tool, input: a.input ?? {} })),
      },
      {
        role: "user",
        content: acts.map((a, i) => ({
          type: "tool_result",
          tool_use_id: p + i,
          content: truncateResult(JSON.stringify(a.result)),
        })),
      },
    ],
  });
  const actions: { tool: string; input: unknown; result: unknown }[] = [];
  attachImages(messages, req, (last, images) => {
    if (typeof last.content !== "string") return;
    last.content = [
      ...images.map((im) => ({
        type: "image",
        source: { type: "base64", media_type: im.mime, data: im.data },
      })),
      { type: "text", text: last.content },
    ];
  });

  // Effort selector (5 levels, Claude Code style) → extended thinking budget.
  // max_tokens must exceed the budget; empty effort = no thinking field at all,
  // so plain relays that reject it keep working at the default level.
  const CLAUDE_EFFORT: Record<string, { budget: number; maxTokens: number }> = {
    low:    { budget: 1024,  maxTokens: 4096 },
    medium: { budget: 4096,  maxTokens: 8192 },
    high:   { budget: 8192,  maxTokens: 16384 },
    xhigh:  { budget: 16384, maxTokens: 32768 },
    max:    { budget: 32768, maxTokens: 49152 },
  };
  const claudeEffort = CLAUDE_EFFORT[cfg.effort ?? ""];
  const thinking = claudeEffort
    ? { type: "enabled", budget_tokens: claudeEffort.budget }
    : undefined;

  // Bounded retries when max_tokens truncates a text-only answer (see below).
  let continuations = 0;

  for (let round = 0; round < 12; round++) {
    if (stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      max_tokens: claudeEffort ? claudeEffort.maxTokens : 4096,
      system: systemPromptFor(req.language),
      tools: TOOLS,
      messages,
      ...(thinking ? { thinking } : {}),
    });
    let data: {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      stop_reason?: string;
      error?: { message?: string };
    };
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: requestBody,
        signal: abortCtl?.signal ?? null,
      });
      data = (await res.json()) as typeof data;
      if (!res.ok) {
        console.error(
          `[ai-assistant] API ${res.status} · 请求 ${requestBody.length} 字符 · ` +
            `messages=${messages.length} tools=${TOOLS.length} · 响应: ${JSON.stringify(data).slice(0, 500)}`,
        );
        throw new Error(data.error?.message || `Claude API 错误 (${res.status})`);
      }
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw err;
    }

    const content = data.content ?? [];
    debugLog(
      context,
      `ROUND ${round}: stop_reason=${data.stop_reason} blocks=${content.map((b) => b.type).join(",")}`,
    );

    // max_tokens cuts the stream mid-block: a trailing tool_use would carry
    // incomplete input (and its echo would lack a tool_result, which the API
    // rejects), a trailing thinking block is incomplete — drop whichever it
    // is. Every block before it completed and is safe to act on.
    if (data.stop_reason === "max_tokens") {
      const last = content[content.length - 1];
      if (last && (last.type === "tool_use" || last.type === "thinking")) content.pop();
    }
    const toolBlocks = content.filter((b) => b.type === "tool_use");

    // Completed tool calls survive a max_tokens cutoff — run them and let the
    // model re-issue the truncated one next round.
    if (toolBlocks.length && (data.stop_reason === "tool_use" || data.stop_reason === "max_tokens")) {
      messages.push({ role: "assistant", content });
      const toolResults: unknown[] = [];
      for (const block of toolBlocks) {
        if (stopRequested) return finishChat(context, actions, stopNote(req.language));
        const resultJson = await callTool(context, actions, block.name!, block.input ?? {}, req.yolo !== false);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultJson,
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Pure text truncation (a long thinking block ate the budget): echo the
    // partial text and ask the model to pick up where it stopped, bounded so
    // a runaway can't burn the whole round budget.
    if (data.stop_reason === "max_tokens") {
      const partial = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      if (continuations < 2) {
        continuations++;
        debugLog(context, `ROUND ${round}: max_tokens — auto-continue ${continuations}/2`);
        messages.push({ role: "assistant", content: partial || "…" });
        messages.push({
          role: "user",
          content:
            "你的上一条回复因长度限制被截断，请从中断处继续，不要重复已输出的内容。" +
            " / Your previous reply was cut off by the token limit — continue exactly where you stopped, without repeating yourself.",
        });
        continue;
      }
      const note = TRUNC_NOTE[req.language ?? ""] ?? TRUNC_NOTE.en;
      return finishChat(context, actions, (partial ? partial + "\n\n" : "") + note);
    }

    const reply =
      content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim() || "（无文本回复）";
    return finishChat(context, actions, reply);
  }
  throw new Error("工具调用次数过多，已中止");
}

// ---------- Proxy-aware HTTP transport ----------
// chatgpt.com / api.openai.com / generativelanguage.googleapis.com are often
// reachable only through a local proxy, and Node's fetch ignores macOS system
// proxy settings — so Codex/Gemini calls go through this helper (CONNECT
// tunnel) instead. The Anthropic path keeps using plain fetch.

let cachedProxy: string | null | undefined;

function detectProxy(): string | null {
  if (cachedProxy !== undefined) return cachedProxy;
  const env =
    process.env.AIBLETON_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (env) {
    cachedProxy = env;
    return env;
  }
  cachedProxy = detectSystemProxy();
  return cachedProxy;
}

interface RawResponse {
  status: number;
  stream: AsyncIterable<Buffer>;
}

/** Minimal HTTPS POST with optional HTTP-proxy CONNECT tunneling. */
function rawPost(
  target: URL,
  init: { headers: Record<string, string>; body: string; proxy: string | null; signal?: AbortSignal },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Abort support: destroy whatever is in flight. Before the response
    // arrives that makes this promise reject; after, it kills the body
    // stream so the caller's read loop throws.
    let current: { destroy: () => void } | null = null;
    const cleanup = () => init.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      current?.destroy();
      cleanup();
      reject(new Error("请求已停止"));
    };
    if (init.signal) {
      if (init.signal.aborted) {
        reject(new Error("请求已停止"));
        return;
      }
      init.signal.addEventListener("abort", onAbort);
    }
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const send = (socket?: tls.TLSSocket) => {
      const reqOpts: https.RequestOptions = {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "content-length": String(Buffer.byteLength(init.body)),
          ...init.headers,
        },
      };
      // Request-level createConnection (no `agent` key at all — passing
      // agent:false makes Node ignore it and dial the target directly).
      if (socket) reqOpts.createConnection = () => socket;
      const req = https.request(reqOpts, (res) => {
        current = req;
        res.on("close", cleanup);
        resolve({ status: res.statusCode ?? 0, stream: res });
      });
      current = req;
      req.on("error", fail);
      req.write(init.body);
      req.end();
    };
    if (!init.proxy) {
      send();
      return;
    }
    let proxy: URL;
    try {
      proxy = new URL(init.proxy);
    } catch {
      fail(new Error(`代理地址无效: ${init.proxy}`));
      return;
    }
    const proxySocket = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      proxySocket.write(
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n${auth}\r\n`,
      );
    });
    current = proxySocket;
    proxySocket.setTimeout(15000, () => {
      proxySocket.destroy();
      fail(new Error(`代理连接超时 (${proxy.host})`));
    });
    let head = "";
    proxySocket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const endIdx = head.indexOf("\r\n\r\n");
      if (endIdx < 0) return;
      proxySocket.removeListener("data", onData);
      proxySocket.setTimeout(0);
      if (!/^HTTP\/\d(?:\.\d)? 200/.test(head)) {
        proxySocket.destroy();
        fail(new Error(`代理 CONNECT 失败: ${head.slice(0, head.indexOf("\r\n"))}`));
        return;
      }
      const secure = tls.connect(
        { socket: proxySocket, servername: target.hostname, ALPNProtocols: ["http/1.1"] },
        () => send(secure),
      );
      current = secure;
      secure.on("error", fail);
    });
    proxySocket.on("error", fail);
  });
}

async function readAll(stream: AsyncIterable<Buffer>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString("utf8");
  return out;
}

// ---------- AI audio generation (Stable Audio) ----------

/** multipart/form-data body for Stability's API (text fields only). */
function multipartBody(fields: Record<string, string>): { body: string; contentType: string } {
  const boundary = "----aibleton" + Math.random().toString(36).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  return { body: body + `--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readAllBinary(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Stable Audio text-to-audio: one synchronous POST that holds the
 * connection until the render finishes (~10–60 s), then answers with the
 * audio bytes (accept: audio/*). Errors still come back as JSON text.
 * Note: the endpoint path is "stable-audio-2" even though the backend now
 * serves Stable Audio 2.5 — there is no versioned 2.5 path (probed 2026-09:
 * the 2.5 path 404s, this one answers 401 without a key).
 */
async function generateStableAudio(
  cfg: AudioGenConfig,
  prompt: string,
  seconds: number,
): Promise<string> {
  const { body, contentType } = multipartBody({
    prompt,
    duration: String(seconds),
    output_format: "wav",
  });
  const res = await rawPost(
    new URL(`${cfg.baseUrl}/v2beta/audio/stable-audio-2/text-to-audio`),
    {
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        accept: "audio/*",
        "content-type": contentType,
      },
      body,
      proxy: detectProxy(),
      signal: abortCtl?.signal ?? undefined,
    },
  );
  if (res.status < 200 || res.status >= 300) {
    const errText = await readAll(res.stream);
    let msg = errText.slice(0, 300);
    try {
      const parsed = JSON.parse(errText) as { errors?: string[]; message?: string };
      msg = parsed.errors?.join("; ") || parsed.message || msg;
    } catch {
      // Not JSON — keep the raw excerpt.
    }
    throw new Error(`Stable Audio API 错误 (${res.status}): ${msg}`);
  }
  const audio = await readAllBinary(res.stream);
  if (!audio.length) throw new Error("Stable Audio 返回了空音频");
  return saveGeneratedAudio(audio, "wav");
}

/**
 * Where generated files land: <User Library>/AIbleton — visible in Live's
 * browser under the User Library and indexed by search_samples (the handler
 * drops the index cache after each generation).
 */
function generatedAudioDir(): string {
  const lib = resolveAbletonLibraryPaths();
  const userLib =
    lib.userLibraries[0] ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "Documents", "Ableton", "User Library")
      : path.join(os.homedir(), "Music", "Ableton", "User Library"));
  return path.join(userLib, "AIbleton");
}

function saveGeneratedAudio(audio: Buffer, ext: string): string {
  const dir = generatedAudioDir();
  mkdirOutsideSandbox(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const file = path.join(dir, `gen-${stamp}-${rand}.${ext}`);
  writeHomeBinary(file, audio);
  return file;
}

// ---------- OpenAI Responses API (Codex) ----------

interface OpenAIOutputItem {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: { type: string; text?: string }[];
}

interface OpenAIResponseData {
  output?: OpenAIOutputItem[];
  error?: { message?: string };
  status?: string;
}

/**
 * The chatgpt.com Codex backend only answers with server-sent events.
 * Consume the stream and return the terminal response object
 * (response.completed / response.failed). Note: this backend sends
 * output:[] in the terminal event — the actual items arrive via
 * response.output_item.done, so they are collected along the way.
 */
async function readResponsesStream(stream: AsyncIterable<Buffer>): Promise<OpenAIResponseData> {
  let buf = "";
  let finalResponse: OpenAIResponseData | null = null;
  let streamError: string | null = null;
  const items: OpenAIOutputItem[] = [];
  for await (const chunk of stream) {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: {
        type?: string;
        response?: OpenAIResponseData;
        item?: OpenAIOutputItem;
        message?: string;
      };
      try {
        evt = JSON.parse(payload) as typeof evt;
      } catch {
        continue;
      }
      if (evt.type === "response.output_item.done" && evt.item) {
        items.push(evt.item);
      } else if (
        evt.type === "response.completed" ||
        evt.type === "response.incomplete" ||
        evt.type === "response.failed"
      ) {
        finalResponse = evt.response ?? null;
      } else if (evt.type === "error") {
        streamError = evt.message ?? "stream error";
      }
    }
  }
  if (finalResponse) {
    if (!finalResponse.output?.length && items.length) finalResponse.output = items;
    return finalResponse;
  }
  if (streamError) throw new Error(streamError);
  throw new Error("OpenAI 流式响应中断（未收到 completed 事件）");
}

async function chatOpenAI(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
  const input: unknown[] = historyWithTools(currentSession(), {
    userText: (text) => ({ role: "user", content: [{ type: "input_text", text }] }),
    assistantText: (text) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
    toolRound: (acts, p) =>
      acts.flatMap((a, i) => [
        { type: "function_call", call_id: p + i, name: a.tool, arguments: JSON.stringify(a.input ?? {}) },
        { type: "function_call_output", call_id: p + i, output: truncateResult(JSON.stringify(a.result)) },
      ]),
  });
  const actions: { tool: string; input: unknown; result: unknown }[] = [];
  attachImages(input, req, (last, images) => {
    if (!Array.isArray(last.content)) return;
    last.content.push(
      ...images.map((im) => ({
        type: "input_image",
        image_url: `data:${im.mime};base64,${im.data}`,
      })),
    );
  });
  const tools = TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));

  for (let round = 0; round < 12; round++) {
    if (stopRequested) return finishChat(context, actions, stopNote(req.language));
    const requestBody = JSON.stringify({
      model: cfg.model,
      instructions: systemPromptFor(req.language),
      input,
      tools,
      store: false,
      // The ChatGPT backend requires SSE streaming; api.openai.com takes plain JSON.
      ...(cfg.chatgpt ? { stream: true } : {}),
      ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
    });
    const proxy = detectProxy();
    const doFetch = () =>
      rawPost(new URL(`${cfg.baseUrl}/responses`), {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.authToken}`,
          ...(cfg.chatgpt
            ? {
                accept: "text/event-stream",
                "chatgpt-account-id": cfg.accountId ?? "",
                "OpenAI-Beta": "responses=experimental",
                originator: "codex_cli_rs",
              }
            : {}),
        },
        body: requestBody,
        proxy,
        signal: abortCtl?.signal,
      });
    let data: OpenAIResponseData;
    let status: number;
    try {
      let res = await doFetch();
      if (res.status === 401 && cfg.chatgpt && cfg.refreshToken) {
        await refreshCodexToken(cfg);
        res = await doFetch();
      }
      status = res.status;
      data = cfg.chatgpt
        ? await readResponsesStream(res.stream)
        : (JSON.parse(await readAll(res.stream)) as OpenAIResponseData);
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw err;
    }
    if (status < 200 || status >= 300) {
      console.error(
        `[ai-assistant] OpenAI API ${status} · 请求 ${requestBody.length} 字符 · 响应: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw new Error(data.error?.message || `OpenAI API 错误 (${status})`);
    }
    if (data.status === "failed") {
      throw new Error(data.error?.message || "OpenAI 响应失败");
    }

    const output = data.output ?? [];
    debugLog(context, `ROUND ${round}: output=${output.map((o) => o.type).join(",")}`);
    const calls = output.filter((o) => o.type === "function_call");
    if (!calls.length) {
      const reply =
        output
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("\n")
          .trim() || "（无文本回复）";
      return finishChat(context, actions, reply);
    }

    // Echo the model's output items back, then append each tool result.
    input.push(...output);
    for (const call of calls) {
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        // Malformed arguments — run with empty input, the tool error explains.
      }
      const resultJson = await callTool(context, actions, call.name!, toolInput, req.yolo !== false);
      input.push({ type: "function_call_output", call_id: call.call_id, output: resultJson });
    }
  }
  throw new Error("工具调用次数过多，已中止");
}

// ---------- Gemini generateContent API ----------

/** Gemini wants OpenAPI-style uppercase types (OBJECT/STRING/…) in schemas. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v);
    }
    return out;
  }
  return schema;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

async function chatGemini(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
  const contents: unknown[] = historyWithTools(currentSession(), {
    userText: (text) => ({ role: "user", parts: [{ text }] }),
    assistantText: (text) => ({ role: "model", parts: [{ text }] }),
    toolRound: (acts) => [
      {
        role: "model",
        parts: acts.map((a) => ({ functionCall: { name: a.tool, args: (a.input ?? {}) as Record<string, unknown> } })),
      },
      {
        role: "user",
        parts: acts.map((a) => ({
          functionResponse: { name: a.tool, response: { result: truncateResult(JSON.stringify(a.result)) } },
        })),
      },
    ],
  });
  const actions: { tool: string; input: unknown; result: unknown }[] = [];
  attachImages(contents, req, (last, images) => {
    if (!Array.isArray(last.parts)) return;
    last.parts.push(
      ...images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })),
    );
  });
  const tools = [
    {
      functionDeclarations: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.input_schema),
      })),
    },
  ];

  // Effort selector (4 levels) → thinking budget. 2.5 Pro can't disable
  // thinking, so "low" gets the minimum useful budget; empty = dynamic default.
  const GEMINI_EFFORT: Record<string, number> = {
    low: 1024,
    medium: 8192,
    high: 16384,
    max: 32768,
  };
  const thinkingBudget = GEMINI_EFFORT[cfg.effort ?? ""];

  for (let round = 0; round < 12; round++) {
    if (stopRequested) return finishChat(context, actions, stopNote(req.language));
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPromptFor(req.language) }] },
      contents,
      tools,
      ...(thinkingBudget ? { generationConfig: { thinkingConfig: { thinkingBudget } } } : {}),
    });
    let data: {
      candidates?: { content?: { parts?: GeminiPart[] } }[];
      error?: { message?: string };
    };
    try {
      const res = await rawPost(
        new URL(`${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`),
        {
          headers: { "content-type": "application/json", "x-goog-api-key": cfg.authToken },
          body: requestBody,
          proxy: detectProxy(),
          signal: abortCtl?.signal,
        },
      );
      data = JSON.parse(await readAll(res.stream)) as typeof data;
      if (res.status < 200 || res.status >= 300) {
        console.error(
          `[ai-assistant] Gemini API ${res.status} · 请求 ${requestBody.length} 字符 · 响应: ${JSON.stringify(data).slice(0, 500)}`,
        );
        throw new Error(data.error?.message || `Gemini API 错误 (${res.status})`);
      }
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw err;
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    debugLog(
      context,
      `ROUND ${round}: parts=${parts.map((p) => (p.functionCall ? "functionCall" : "text")).join(",")}`,
    );
    const fnCalls = parts.filter((p) => p.functionCall?.name);
    if (!fnCalls.length) {
      const reply =
        parts
          .filter((p) => typeof p.text === "string")
          .map((p) => p.text!)
          .join("\n")
          .trim() || "（无文本回复）";
      return finishChat(context, actions, reply);
    }

    contents.push({ role: "model", parts });
    const responseParts: unknown[] = [];
    for (const p of fnCalls) {
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      const name = p.functionCall!.name!;
      const resultJson = await callTool(context, actions, name, p.functionCall!.args ?? {}, req.yolo !== false);
      responseParts.push({ functionResponse: { name, response: { result: resultJson } } });
    }
    contents.push({ role: "user", parts: responseParts });
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

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      send(200, chatInterface.replaceAll("__APP_VERSION__", APP_VERSION), "text/html");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/health")) {
      const providerParam =
        new URL(req.url, "http://127.0.0.1").searchParams.get("provider") ?? undefined;
      const provider: Provider =
        providerParam === "codex" || providerParam === "gemini" ? providerParam : "claude";
      const cfg = resolveConfig({ provider });
      const manual = manualConfigs[provider];
      const source =
        manual && (manual.apiKey || manual.authToken || manual.refreshToken)
          ? "manual"
          : loadLocalConfig(provider)
            ? "cli"
            : "none";
      send(200, JSON.stringify({
        ok: true,
        provider: cfg.provider,
        hasAuth: Boolean(cfg.authToken),
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        source,
      }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/provider-config")) {
      const providerParam =
        new URL(req.url, "http://127.0.0.1").searchParams.get("provider") ?? undefined;
      const provider: Provider =
        providerParam === "codex" || providerParam === "gemini" ? providerParam : "claude";
      const cli = loadLocalConfig(provider);
      send(200, JSON.stringify({
        provider,
        manual: manualConfigs[provider] ?? null,
        detected: cli
          ? {
              baseUrl: cli.baseUrl,
              model: cli.model,
              hasAuth: Boolean(cli.apiKey || cli.authToken || cli.refreshToken),
            }
          : null,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/provider-config") {
      readBody((parsed) => {
        const provider: Provider =
          parsed.provider === "codex" || parsed.provider === "gemini"
            ? parsed.provider
            : "claude";
        const fields = (parsed.config ?? {}) as Record<string, unknown>;
        const cur: LocalConfig = { ...(manualConfigs[provider] ?? {}) };
        for (const key of ["baseUrl", "authToken", "apiKey", "model", "accountId", "refreshToken", "reasoningEffort"] as const) {
          const v = fields[key];
          if (typeof v === "string" && v.trim()) (cur as Record<string, unknown>)[key] = v.trim();
          else if (key in fields) delete (cur as Record<string, unknown>)[key];
        }
        if (Object.keys(cur).length) manualConfigs[provider] = cur;
        else delete manualConfigs[provider];
        saveManualConfigs();
        send(200, JSON.stringify({ ok: true, manual: manualConfigs[provider] ?? null }));
      });
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
      send(200, JSON.stringify({
        busy,
        error: lastError,
        pending: pendingConfirm ? { tool: pendingConfirm.tool, input: pendingConfirm.input } : null,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/confirm") {
      readBody((parsed) => {
        const waiting = pendingConfirm;
        if (waiting) waiting.resolve(parsed.allow === true);
        send(waiting ? 200 : 409, JSON.stringify({ ok: Boolean(waiting) }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/stop") {
      // UI stop button: flag the running task, abort its in-flight request,
      // and release any tool call waiting on Allow/Deny so it can unwind.
      if (busy) {
        stopRequested = true;
        abortCtl?.abort();
        if (pendingConfirm) pendingConfirm.resolve(false);
        debugLog(context, "STOP requested");
        send(200, JSON.stringify({ ok: true }));
      } else {
        send(409, JSON.stringify({ ok: false, error: "当前没有运行中的任务" }));
      }
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
        // Text attachments fold into the stored message (so history keeps their
        // content); images leave a marker — the base64 itself only rides this
        // turn's API request, never the history file.
        let content = text;
        for (const a of (parsed.attachments as Attachment[] | undefined)?.slice(0, 10) ?? []) {
          if (typeof a?.text === "string") {
            content += `\n\n【附件 ${a.name}】\n${a.text.slice(0, 20000)}`;
          } else if ((a?.kind === "midi" || a?.kind === "als") && typeof a.data === "string") {
            // Binary music files reach the model as a parsed text summary.
            content += `\n\n【附件 ${a.name}】\n${describeBinaryAttachment(a.name, a.kind, a.data)}`;
          } else if (typeof a?.data === "string") {
            content += `\n[图片: ${a.name}]`;
          }
        }
        session.messages.push({ role: "user", content });
        if (session.title === "新对话") session.title = text.slice(0, 24);
        session.updatedAt = Date.now();
        saveStore(context);
        busy = true;
        lastError = null;
        stopRequested = false;
        abortCtl = new AbortController();
        activeAudioConfig = resolveAudioConfig(parsed);
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
            abortCtl = null;
            // Never leave a confirmation dangling past its task's lifetime.
            if (pendingConfirm) pendingConfirm.resolve(false);
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
    loadManualConfigs(context);
    tryListen(PREFERRED_PORT);
  });
}
