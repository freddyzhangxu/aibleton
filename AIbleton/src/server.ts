import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The Live extension sandbox does NOT expose Node's usual globals — URL and
// Buffer must be imported explicitly (a bare `new URL()` crashes the process
// with ReferenceError inside request handlers).
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { describeBinaryAttachment } from "./fileparsers.js";
import { detectProxy, rawPost, readAll } from "./http.js";
import { webFetch, webSearch } from "./websearch.js";
import {
  AUDIO_PROVIDER_NAMES,
  audioProviderEnv,
  generateAudio,
  generatedAudioDir,
  resolveAudioConfig,
  type AudioGenConfig,
  type AudioProvider,
  type AudioRequestConfig,
  type CustomAudioTemplate,
} from "./audiogen.js";
import {
  AUDIO_EXT,
  kitRoots,
  listAudioFilesViaFind,
  mkdirOutsideSandbox,
  pathExists,
  readHomeBinary,
  readHomeFile,
  sampleRoots,
  storeFallbackPath,
  writeHomeBinary,
  writeHomeFile,
} from "./paths.js";
import {
  MoveError,
  downloadSet,
  listFiles,
  listSets,
  moveHost,
  pairComplete,
  pairStart,
  systemVersion,
  uploadFile,
} from "./move.js";
import {
  AudioClip,
  AudioTrack,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  Simpler,
  type Clip,
  type Device,
  type DeviceParameter,
  type ExtensionContext,
  type NoteDescription,
  type Song,
  type Track,
  type ClipLoopSettings,
} from "@ableton-extensions/sdk";
import { analyzeMusicState, analyzeSong, presentAnalysis, selectMusicContext } from "./analysis/index.js";
import { enrichMusicStateWithAudio } from "./audiofiles.js";
import { buildMusicState, tileClipNotes } from "./musicstate/builder.js";
import type { SnapshotClip, SongSnapshot } from "./musicstate/types.js";
import { postconditionsFor } from "./verify/rules.js";
import { runVerification } from "./verify/verifier.js";
import type { ProbeSong } from "./verify/types.js";
import { CRITERION_KINDS, GOAL_TYPES, goalNeedsAudio, normalizeGoal, type GoalEvaluation, type MusicGoal } from "./goal/types.js";
import { buildGoalView, type GoalView } from "./goal/view.js";
import { evaluateGoal } from "./goal/evaluate.js";
import { EFFECT_METRICS, normalizePlan, planNeedsAudio, type MusicPlan } from "./plan/types.js";
import { buildPlanReport, executedStepIds, type PlanReport } from "./plan/check.js";
import {
  buildMusicIntelligence,
  presentGoalContext,
  projectGoalContext,
  type MusicIntelligence,
} from "./music/intelligence/index.js";
import {
  buildSectionPlanningContext,
  presentSectionPlanningContext,
  presentSectionVerification,
  verifySectionChange,
  type SectionPlanningContext,
  type SectionVerification,
} from "./music/sections/index.js";
import {
  analyzeReferenceBuffer,
  buildReferenceIntelligence,
  buildReferencePlanningContext,
  presentReferencePlanningContext,
  presentReferenceVerification,
  verifyReferenceProgress,
  REFERENCE_ANALYZER_VERSION,
  type ReferenceAnalysis,
  type ReferenceError,
  type ReferenceSource,
} from "./music/reference/index.js";
import {
  AGENT_MAX_RETRIES,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_STEPS,
  countMutations,
  gateAction,
  mutationsLeft,
  stepBudgetError,
} from "./agent/loop.js";
import { moveExtras, moveSongToSnapshot, parseMoveBundle } from "./movebundle.js";
import { searchSampleIndex, toSampleEntry, type SampleEntry } from "./samplemeta.js";

// ---------- Local sample library search ----------

let sampleIndex: SampleEntry[] | null = null;

function buildSampleIndex(): SampleEntry[] {
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
  // Parse BPM/key from file & folder names once — search time is then pure matching.
  const t0 = Date.now();
  sampleIndex = out.map(toSampleEntry);
  console.log(
    `[ai-assistant] 采样索引: ${out.length} 个文件 (+${Date.now() - t0}ms 元数据解析)，来源: ${roots.join(" | ")}`,
  );
  return sampleIndex;
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

type Provider = "claude" | "codex" | "gemini" | "custom";

const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  custom: "Custom",
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
  // Custom endpoints have no CLI to autodetect from — settings-UI config only.
  if (provider === "custom") return null;
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
/** Last-used provider, persisted alongside manualConfigs — the in-Live
 * webview's localStorage doesn't survive reopening, so the UI asks the
 * server which provider to default to. */
let lastProvider: Provider = "claude";

/** Audio-generation settings from the settings UI, persisted in the same
 * providers.json (same localStorage-loss problem as lastProvider). */
type PersistedAudio = {
  selected?: AudioProvider;
  fields: Partial<Record<AudioProvider, { apiKey?: string; baseUrl?: string }>>;
  custom: CustomAudioTemplate;
};
let audioSettings: PersistedAudio = { fields: {}, custom: {} };

/** Web-search toggle from the settings UI, persisted in providers.json.
 * Default OFF: web_search/web_fetch are advertised to the model (and allowed
 * to run) only when the user explicitly turns this on. */
let webSettings = { enabled: false };

/** Ableton Move pairing state (host + challenge-response token), persisted in
 * providers.json under "move" — same localStorage-loss problem as lastProvider. */
let moveSettings: { host?: string; token?: string } = {};

/**
 * The user's durable musical identity, persisted as memory.json in the same
 * storage directory (same readHomeFile/writeHomeFile pattern as providers.json,
 * but a separate file so it stays easy to hand-edit or share). Injected into
 * the system prompt of every chat; kept fresh by the update_memory tool.
 * All fields optional — an empty object means "no memory yet".
 */
type ArtistMemory = {
  name?: string;
  genres?: string[];
  bpmMin?: number;
  bpmMax?: number;
  keys?: string[];
  sound?: string[];
  artists?: string[];
  notes?: string;
};
let artistMemory: ArtistMemory = {};
let memoryPath: string | null = null;

/** Normalize an unknown value into a non-empty string array, or undefined. */
function toStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** Normalize an unknown value into a BPM in Live's valid range, or undefined. */
function toBpm(v: unknown): number | undefined {
  const n = Number(v);
  return n >= 20 && n <= 999 ? n : undefined;
}

function loadArtistMemory(context: Ctx): void {
  // Same directory resolution as loadManualConfigs (storage dir or fallback).
  const dir = storeFileOverride
    ? path.dirname(storeFileOverride)
    : context.environment.storageDirectory || path.dirname(storeFallbackPath());
  memoryPath = path.join(dir, "memory.json");
  artistMemory = {};
  try {
    const raw = readHomeFile(memoryPath);
    if (!raw) return; // No memory yet — normal on first run.
    const d = JSON.parse(raw) as Record<string, unknown>;
    const p: ArtistMemory = {};
    if (typeof d.name === "string" && d.name.trim()) p.name = d.name.trim();
    p.genres = toStrArr(d.genres);
    p.keys = toStrArr(d.keys);
    p.sound = toStrArr(d.sound);
    p.artists = toStrArr(d.artists);
    p.bpmMin = toBpm(d.bpmMin);
    p.bpmMax = toBpm(d.bpmMax);
    if (p.bpmMin && p.bpmMax && p.bpmMin > p.bpmMax) {
      [p.bpmMin, p.bpmMax] = [p.bpmMax, p.bpmMin];
    }
    if (typeof d.notes === "string" && d.notes.trim()) p.notes = d.notes.trim();
    artistMemory = p;
    // Object.keys would also count keys assigned undefined — count real values.
    const n = Object.values(p).filter((v) => v !== undefined).length;
    if (n) console.log(`[ai-assistant] Artist memory 已加载（${n} 个字段）: ${p.name ?? p.genres?.join("/") ?? "…"}`);
  } catch {
    artistMemory = {};
  }
}

function saveArtistMemory(): void {
  if (!memoryPath) return;
  try {
    mkdirOutsideSandbox(path.dirname(memoryPath));
    writeHomeFile(memoryPath, JSON.stringify(artistMemory, null, 2));
  } catch {
    // In-memory copy still works for this run.
  }
}

const AUDIO_PROVIDERS_ALL: AudioProvider[] = ["stable-audio", "elevenlabs", "minimax", "custom"];

/**
 * Merge a chat request's audio overrides with the persisted settings:
 * per-request fields win, saved settings fill the gaps (and pick the
 * provider when the request says nothing).
 */
function mergeAudioRequest(audio: AudioRequestConfig | undefined): AudioRequestConfig | undefined {
  const sel = audio?.provider ?? audioSettings.selected;
  if (!sel || !AUDIO_PROVIDERS_ALL.includes(sel as AudioProvider)) return audio;
  const p = sel as AudioProvider;
  const f = audioSettings.fields[p] ?? {};
  if (p === "custom") {
    return {
      provider: "custom",
      apiKey: audio?.apiKey || f.apiKey || undefined,
      baseUrl: audio?.baseUrl || f.baseUrl || undefined,
      custom: { ...audioSettings.custom, ...(audio?.custom ?? {}) },
    };
  }
  return {
    provider: p,
    apiKey: audio?.apiKey || f.apiKey || undefined,
    baseUrl: audio?.baseUrl || f.baseUrl || undefined,
  };
}

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
      Partial<Record<Provider, LocalConfig>> & {
        lastProvider?: unknown;
        audio?: Partial<PersistedAudio>;
        web?: { enabled?: unknown };
        move?: { host?: unknown; token?: unknown };
      };
    manualConfigs = {};
    for (const p of ["claude", "codex", "gemini", "custom"] as Provider[]) {
      const cfg = data[p];
      if (cfg && typeof cfg === "object") manualConfigs[p] = cfg;
    }
    if (data.lastProvider === "claude" || data.lastProvider === "codex" ||
        data.lastProvider === "gemini" || data.lastProvider === "custom") {
      lastProvider = data.lastProvider;
    }
    const a = data.audio;
    if (a && typeof a === "object") {
      audioSettings = {
        selected: AUDIO_PROVIDERS_ALL.includes(a.selected as AudioProvider)
          ? (a.selected as AudioProvider)
          : undefined,
        fields: (a.fields ?? {}) as PersistedAudio["fields"],
        custom: (a.custom ?? {}) as CustomAudioTemplate,
      };
    }
    webSettings.enabled = data.web?.enabled === true;
    const mv = data.move;
    if (mv && typeof mv === "object") {
      moveSettings = {
        host: typeof mv.host === "string" && mv.host ? mv.host : undefined,
        token: typeof mv.token === "string" && mv.token ? mv.token : undefined,
      };
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
    writeHomeFile(manualConfigPath,
      JSON.stringify({ ...manualConfigs, lastProvider, audio: audioSettings, web: webSettings, move: moveSettings }, null, 2));
  } catch {
    // In-memory copy still works for this run.
  }
}

type Ctx = ExtensionContext<"1.0.0">;

// ---------- Audio-generation providers (see audiogen.ts) ----------

/**
 * Audio-generator config for the running chat task. Rides the chat request
 * (same per-request override pattern as the chat provider keys) and is
 * resolved once per /api/chat — `busy` guarantees a single task at a time.
 */
let activeAudioConfig: AudioGenConfig | null = null;

/** UI language of the running chat task — feeds the web tools' search locale
 * (same per-request lifetime as activeAudioConfig; busy = one task at a time). */
let activeLanguage: string | undefined;

// ---------- Claude tool definitions ----------

/** Shared description for the optional track_name param on every track tool. */
const TRACK_NAME_DESC =
  "Track name as listed by get_song_overview. Always pass it together with the index: " +
  "the pair is verified and the track is re-resolved by name if the index has shifted since.";

/** Flat parameter bag for goal criteria — one schema for every kind keeps it
 * emittable for weak models (no per-kind nesting); the kind-specific required
 * params are enforced server-side in goal/types.ts's normalizeGoal. */
const CRITERION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...CRITERION_KINDS],
      description:
        "section_energy_gt: section a's note density must exceed b's (a, b = section names; b may be " +
        "\"baseline:<name>\" to compare against the same section's pre-change value). " +
        "section_tracks_gte: a section's active-track count >= n. " +
        "role_present: a role (kick|bass|drums|chords|pad|lead|…, or the group low_end = kick|bass) is audible " +
        "in `section` (whole song when section omitted). " +
        "tempo_unchanged / key_unchanged: self-explanatory. " +
        "track_count_gte: total track count >= n. no_new_tracks: no tracks added. " +
        "tracks_untouched: the named tracks keep identical note content (mixer/device tweaks not covered). " +
        "track_crest_gte: the track's clip SOURCE FILES must reach crest >= db dB (kick punch ≈ 6+ dB). " +
        "track_band_gte: the track's clip SOURCE FILES must have >= pct (0-1) of spectral energy in `band` " +
        "(sub|bass|lowMid|mid|highMid|high). WARNING: the audio kinds judge the source file, pre-warp/pre-gain/" +
        "pre-device — mixer/EQ/compressor/warp edits NEVER move them; only replacing the sample does. Declare " +
        "them only when sample replacement is an acceptable route.",
    },
    a: { type: "string", description: "section_energy_gt: section that must win" },
    b: { type: "string", description: "section_energy_gt: section to beat, or \"baseline:<name>\"" },
    section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
    role: { type: "string", description: "role_present: role name, or group low_end" },
    n: {
      anyOf: [{ type: "number" }, { type: "string" }],
      description: "A number, or \"baseline\" = the value when the goal was declared",
    },
    names: { type: "array", items: { type: "string" }, description: "tracks_untouched: track names" },
    track: { type: "string", description: "track_crest_gte / track_band_gte: track name" },
    db: { type: "number", description: "track_crest_gte: minimum crest factor in dB" },
    band: {
      type: "string",
      description: "track_band_gte: sub | bass | lowMid | mid | highMid | high",
    },
    pct: { type: "number", description: "track_band_gte: minimum band energy fraction (0-1)" },
  },
  required: ["kind"],
};

const TOOLS = [
  {
    name: "get_song_overview",
    description:
      "Get an overview of the current Live Set: tempo, scale, all tracks (name, type, mute/solo/arm, clips, devices) and scenes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "analyze_song",
    description:
      "Deep read-only musical analysis of the Set: detected key (Krumhansl, duration-weighted, drums excluded) vs Live's scale setting, per-track roles (kick/bass/pad/…) with note/velocity/density/polyphony stats, section structure (cue points, else 8-bar energy blocks), session-view summary, rule-based issues (flat dynamics, low contrast, off-key notes, monotone bass, duplicate tracks, muted content), and a flat clip map (every arrangement clip's track/clip_index/bar/length + every session clip's track/scene_index — the coordinates arrange_song plans against). By default audio clips contribute filename + duration; pass audio:true to decode clip source files (WAV/AIFF) for per-track loudness/crest/dynamic-range/6-band balance and audio-derived issues (weak transients, thin low end, squashed dynamics, dull/harsh top) — features describe the source FILE, pre-warp/pre-gain/pre-device. Call before suggesting structural changes or when you need key/role context. Track indices match get_song_overview. Optional focus narrows the read to what matters for the question.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description:
            "Optional: narrow the analysis to what matters — a track name or role (\"bass\", \"drums\", \"vocal\"), a section name, or an issue code (\"MONOTONE_BASS\"). Focused tracks keep full stats and the clip map keeps only their clips; other tracks collapse to one-line summaries (indices stay valid). Omit for the full read.",
        },
        audio: {
          type: "boolean",
          description:
            "Optional: decode audio clip source files (WAV/AIFF) and add per-track audio features (rms/crest/dynamic-range/loudness/6-band energy/transient density) plus audio-derived issues. Slower on first run (file reads + FFT), cached afterwards. Features describe the source file, pre-warp/pre-gain/pre-device — not the audible result through the device chain.",
        },
      },
    },
  },
  {
    name: "set_goal",
    description:
      "Declare the user's current task as a goal with MACHINE-CHECKABLE success criteria — call it FIRST, " +
      "before any Set-modifying tool, whenever the user asks for a musical change (create/edit/arrange/mix/sound_design/fix). " +
      "The server snapshots the Set as the baseline when you declare; when you stop calling tools it evaluates every " +
      "criterion against the new state, and unmet ones come back as a 目标校验 message (keep working, or explain the " +
      "blocker — never claim completion while criteria are unmet). Criteria are a CLOSED vocabulary: pick a kind and " +
      "fill its parameters — never invent kinds. Use analyze_song first to learn section names, then write 1–4 " +
      "criteria that actually define the outcome (\"make the drop harder\" → section_energy_gt Drop vs Intro + " +
      "role_present low_end in Drop). Skip set_goal for questions, analysis requests, and single-parameter tweaks " +
      "(those results are already verified per-call). The result carries a music block — measured features, " +
      "contrasts and evidence-backed observations relevant to your declared goal; base your criteria thresholds " +
      "and set_plan steps on those numbers, never on guesses.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...GOAL_TYPES] },
        objective: {
          type: "string",
          description: "One human-readable sentence. Shown to the user, NEVER evaluated — only criteria are.",
        },
        target: {
          type: "object",
          properties: {
            track: { type: "string", description: "Track NAME (indices drift, names don't)" },
            section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
          },
        },
        constraints: {
          type: "array",
          description: "Hard boundaries that must still hold at the end (tempo_unchanged, no_new_tracks, tracks_untouched…)",
          items: CRITERION_INPUT_SCHEMA,
        },
        successCriteria: {
          type: "array",
          description: "End-state conditions defining 'done' — 1–4, each must be checkable against the Set's structure",
          items: CRITERION_INPUT_SCHEMA,
        },
        reference: {
          type: "object",
          description:
            "Optional REFERENCE TRACK (local WAV/AIFF file) the goal's target section should be compared against. " +
            "The server analyzes it LOCALLY (never uploaded) and returns a reference block: the aligned reference section, " +
            "measured gaps (energy/density/rhythm/impact…, delta = reference − current), and conservative action hints. " +
            "Reference is EVIDENCE, not the goal: still write your own successCriteria — the gate judges your criteria, " +
            "reference progress is supporting evidence only. Never try to copy or clone the reference.",
          properties: {
            path: { type: "string", description: "Absolute path to the reference audio file (WAV/AIFF)" },
            section: {
              type: "string",
              description: "Optional: pin the reference section to compare against (id from a previous reference block, e.g. \"reference:section:3\")",
            },
            tempo_bpm: { type: "number", description: "Optional tempo hint when the reference's BPM is known — sharpens the beat axis" },
          },
          required: ["path"],
        },
      },
      required: ["type", "objective", "successCriteria"],
    },
  },
  {
    name: "set_plan",
    description:
      "Declare your step-by-step plan for the declared goal — call it AFTER set_goal, BEFORE any Set-modifying " +
      "tool, whenever the task needs 2+ tool calls or multiple stages. Each step names the tool you expect to " +
      "call and the expectedEffects it should produce, so you always know WHY you call a tool and WHAT should " +
      "change afterwards. Effects are a CLOSED vocabulary (see the schema): pick a metric and fill its " +
      "parameters — never invent metrics. The server tracks which steps actually execute (matched from your " +
      "tool calls) and, if the goal check fails at the end, reports per step: which steps never ran and which " +
      "predicted effects were NOT observed against the measured Set — use that to fix the right step instead " +
      "of repeating calls blindly. Skip set_plan for single-call tweaks. Re-declaring replaces the plan.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered plan steps (max 12). Keep descriptions short and musical.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional stable id (auto-assigned step-N when omitted)" },
              description: {
                type: "string",
                description: "One short sentence of intent, e.g. \"Add open-hat pattern to the drop\"",
              },
              tool: {
                type: "string",
                description: "The tool expected to carry out this step (must be a real tool name)",
              },
              args: {
                type: "object",
                description: "Optional sketch of the intended call arguments — display only, never validated",
              },
              expectedEffects: {
                type: "array",
                description: "What this step should measurably change (max 4 per step) — checked against the Set at the end",
                items: {
                  type: "object",
                  properties: {
                    metric: {
                      type: "string",
                      enum: [...EFFECT_METRICS],
                      description:
                        "section_energy: a section's note density (notes/bar) moves vs baseline — needs section + direction. " +
                        "section_tracks: a section's active-track count moves — needs section + direction. " +
                        "role_audible: a role (kick|bass|drums|chords|pad|lead|…, or group low_end) is audible afterwards — " +
                        "needs role, optional section (whole song when omitted), NO direction. " +
                        "track_notes: a track's audible note count moves — needs track (name) + direction. " +
                        "track_count / tempo: total tracks / song tempo moves — need direction only. " +
                        "track_crest: the track's clip SOURCE FILE crest factor (dB) moves — needs track + direction. " +
                        "track_band_energy: the track's clip SOURCE FILE energy fraction in `band` (sub|bass|lowMid|mid|highMid|high) " +
                        "moves — needs track + direction + band. The audio metrics judge the source file: mixer/warp/device edits " +
                        "never move them — only replacing the sample does.",
                    },
                    direction: {
                      type: "string",
                      enum: ["increase", "decrease"],
                      description: "Required for every metric except role_audible",
                    },
                    section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
                    track: { type: "string", description: "track_notes / track_crest / track_band_energy: track NAME (indices drift, names don't)" },
                    role: { type: "string", description: "role_audible: role name, or group low_end" },
                    band: { type: "string", description: "track_band_energy: sub | bass | lowMid | mid | highMid | high" },
                  },
                  required: ["metric"],
                },
              },
            },
            required: ["description"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "arrange_song",
    description:
      "Build or rebuild the arrangement in ONE call from a placement plan. Each placement copies a source clip — an arrangement clip via clip_index, or a session clip via scene_index — onto ITS OWN track at start_bar for length_bars. Looping sources tile their loop region to fill the length; one-shots play once and leave silence. The whole plan is validated BEFORE anything changes (bad references and same-track overlaps abort with zero writes) and executed as a single undo step. MIDI clips are baked note-by-note (tiled/trimmed); audio clips reference the same file (warp markers, fades and automation are NOT carried over). Sources stay untouched. Use analyze_song's clip map for source coordinates. Optional clear_range_bars wipes ALL tracks' clips in that inclusive bar range first — only for rebuilds. dry_run validates and reports the resolved plan without touching the Set. Cannot move clips across tracks or delete individual clips.",
    input_schema: {
      type: "object",
      properties: {
        placements: {
          type: "array",
          description: "What to place where (max 128). Pass [] with clear_range_bars to only clear.",
          items: {
            type: "object",
            properties: {
              track_index: { type: "number", description: "Source/target track, 0-based" },
              track_name: { type: "string", description: TRACK_NAME_DESC },
              clip_index: {
                type: "number",
                description: "Source: arrangement clip index on that track (from analyze_song's clip map). Mutually exclusive with scene_index.",
              },
              scene_index: {
                type: "number",
                description: "Source: session slot index on that track. Mutually exclusive with clip_index.",
              },
              start_bar: { type: "number", description: "Target position, 1-based bar number" },
              length_bars: { type: "number", description: "How long the new clip plays, in bars (> 0)" },
              name: { type: "string", description: "New clip name (default: source clip's name)" },
            },
            required: ["start_bar", "length_bars"],
          },
        },
        clear_range_bars: {
          type: "array",
          items: { type: "number" },
          description: "[startBar, endBar] inclusive — clear ALL tracks' clips in this range before placing (partially overlapping clips are trimmed to the range edge). Only for rebuilds.",
        },
        dry_run: {
          type: "boolean",
          description: "Validate and return the resolved plan without changing the Set",
        },
      },
      required: ["placements"],
    },
  },
  {
    name: "update_memory",
    description:
      "Update the user's persistent artist memory — their musical identity, saved to memory.json and injected into every chat's system prompt. " +
      "Call ONLY when the user states a durable preference about their own style (\"I make melodic techno around 124\", \"remember I prefer 909 drums\") " +
      "— never for one-off choices that apply only to the current Set, and never speculatively. " +
      "Pass only the fields to change: omitted fields stay unchanged; strings/arrays REPLACE the previous value (pass \"\" or [] to clear a field; 0 clears bpmMin/bpmMax).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Artist / project name" },
        genres: { type: "array", items: { type: "string" }, description: "Genres the user produces, e.g. [\"melodic techno\", \"deep house\"]" },
        bpmMin: { type: "number", description: "Lower end of the usual BPM range (20–999); 0 to clear" },
        bpmMax: { type: "number", description: "Upper end of the BPM range (same as bpmMin for one fixed BPM); 0 to clear" },
        keys: { type: "array", items: { type: "string" }, description: "Preferred musical keys, e.g. [\"A minor\", \"F# minor\"]" },
        sound: { type: "array", items: { type: "string" }, description: "Sound/timbre preferences, e.g. [\"909 drums\", \"warm analog pads\", \"acid basslines\"]" },
        artists: { type: "array", items: { type: "string" }, description: "Reference artists whose style the user likes" },
        notes: { type: "string", description: "Free-form notes about the user's style, goals or workflow" },
      },
    },
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
    name: "create_move_track",
    description:
      "Create a MIDI track for sequencing an Ableton Move hardware unit over USB-C (firmware ≥1.5, Standalone Mode). The SDK cannot set MIDI output routing — the returned message contains one-time manual routing steps that MUST be relayed to the user. Afterwards, write clips into this track with write_midi_clip / write_session_clip as usual.",
    input_schema: {
      type: "object",
      properties: {
        channel: {
          type: "number",
          description:
            "MIDI channel the Move track listens on (1–16, default 1). On Move, a track's MIDI In channel is set via Shift + track button; 'Auto' accepts all channels not explicitly assigned to other tracks.",
        },
        name: { type: "string", description: "Track name (default: 'Move Ch <channel>')" },
      },
    },
  },
  {
    name: "move_status",
    description:
      "Check the connection to an Ableton Move on the local network: reachability, pairing state and firmware version.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_pair",
    description:
      "Pair with an Ableton Move over WiFi. Without `code`: makes the Move display a 6-digit pairing code — ask the user to read it off the device screen. With `code`: completes pairing and remembers the token for future sessions.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-digit code shown on the Move's display" },
        host: { type: "string", description: "Hostname or IP (default: move.local)" },
      },
    },
  },
  {
    name: "move_list_sets",
    description: "List the Sets stored on the paired Ableton Move (id, name, modified date).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_list_files",
    description:
      "List folders and files in the Move's user storage (samples, recordings). Without `path`, lists the root folders.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path, e.g. \"Samples\" or \"Samples/Drums\"" },
      },
    },
  },
  {
    name: "move_upload_sample",
    description:
      "Upload a local audio file (WAV/AIFF/MP3/FLAC/OGG/M4A) to the paired Move — e.g. a file just created by generate_audio. Lands in the given folder on the device (default \"Samples\"), ready to load into a drum pad or melodic track.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the local audio file" },
        folder: { type: "string", description: "Target folder on the Move (default \"Samples\")" },
        overwrite: { type: "boolean", description: "Replace an existing file with the same name (default false)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "move_download_set",
    description:
      "Download a Set (.ablbundle) from the paired Move into the User Library's AIbleton folder.",
    input_schema: {
      type: "object",
      properties: {
        set_id: { type: "string", description: "Set id from move_list_sets" },
      },
      required: ["set_id"],
    },
  },
  {
    name: "move_analyze_set",
    description:
      "Download a Set from the paired Move and analyze it like analyze_song: key detection, per-track roles/note stats, muted content and issue flags — plus Move extras (per-track mixer levels, device chains, sample list with durations). The .ablbundle is kept in the User Library's AIbleton folder. Move has no arrangement view, so all clips are session clips.",
    input_schema: {
      type: "object",
      properties: {
        set_id: { type: "string", description: "Set id from move_list_sets" },
        focus: {
          type: "string",
          description: "Optional, same as analyze_song's focus: narrow the read to a track name, role, or issue code.",
        },
      },
      required: ["set_id"],
    },
  },
  {
    name: "rename_track",
    description: "Rename a track by its 0-based index (as listed by get_song_overview).",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC + " (its CURRENT name, before the rename)" },
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "set_track_state",
    description: "Mute, unmute, solo, unsolo, arm or disarm a track by its 0-based index.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        mute: { type: "boolean" },
        solo: { type: "boolean" },
        arm: { type: "boolean" },
      },
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_name: { type: "string" },
      },
      required: ["device_name"],
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number", description: "0-based device index on the track" },
        device_name: { type: "string", description: 'Device name, e.g. "Operator" (alternative to device_index)' },
        filter: { type: "string", description: "Optional case-insensitive name filter" },
      },
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
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
      required: ["parameter", "value"],
    },
  },
  {
    name: "load_drum_kit",
    description:
      'Load Ableton\'s factory 808 drum kit into a track: builds a Drum Rack with Simpler pads loaded with real 808 samples (from the Drum Essentials pack). Reuses an existing EMPTY Drum Rack on the track if present, otherwise creates one. Pad note map (use these pitches in write_midi_clip): 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 75=Clave. THIS is the way to make drums audible — prefer it over insert_device for drums.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
      },
    },
  },
  {
    name: "search_samples",
    description:
      'Search local sample libraries — Splice folder (if the Splice app is installed and synced), Ableton User Library, Factory Packs, and Live\'s Core Library. Understands musical metadata in file names: BPM ("124 bpm" or a bare "124"), key ("Am", "F#", "Bb major"), instruments (kick, pad, 808, vocal…) and vibe words — synonyms are built in, so "dark" also matches rumble/industrial/sub, "warm" → analog/tape/mellow, "punchy" → punch/tight. All keywords must match; results are RANKED — exact BPM/key matches first, then relative major/minor, then relevance. Returns up to 30 full file paths plus how the query was parsed. Queries like "dark pad 124 bpm am", "808 kick", "tech house loop". Note: Splice\'s online catalog cannot be browsed — only locally synced files are searchable.',
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for CURRENT information — software versions and release notes, prices, tutorials, news, facts you don't know. Free and keyless. Returns up to 8 results with title/URL/snippet. For LOCAL sample files on the user's disk use search_samples instead.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Specific keywords, e.g. "Ableton Live 12.3 release notes"' },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its readable text (static HTML only — JS-rendered pages may return little). Use after web_search to read the most promising result in full, or on a URL the user pasted.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL" } },
      required: ["url"],
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        file_path: { type: "string", description: "Full path from search_samples" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0)" },
        duration_beats: { type: "number", description: "Optional clip length in beats" },
        warped: { type: "boolean", description: "Enable warping (default: Live's auto-warp setting)" },
      },
      required: ["file_path"],
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        file_path: { type: "string", description: "Full path from search_samples" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "generate_audio",
    description:
      "Generate NEW audio with an AI music model (Stable Audio / ElevenLabs / MiniMax — whichever is configured in Settings) and save it into the User Library's 'AIbleton' folder. Costs API credits and takes ~10–60 s. Returns the saved file path — then call import_audio_clip (loops onto an audio track's arrangement) or load_sample (one-shots into a Simpler).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "English, specific: genre, BPM, key, instrumentation, mood. Add 'seamless loop' for loops.",
        },
        duration_seconds: { type: "number", description: "1–190 (default 8); use 4–16 for loops" },
        instrumental: {
          type: "boolean",
          description: "Guarantee no vocals (ElevenLabs / MiniMax; Stable Audio is always instrumental)",
        },
        lyrics: {
          type: "string",
          description: "Vocal lyrics — MiniMax only; omit for instrumentals",
        },
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
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
      required: ["notes"],
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        scene_index: { type: "number" },
        length_beats: { type: "number", description: "Clip length in beats (default 16)" },
        name: { type: "string" },
        swing: {
          type: "number",
          description: "Swing amount 0–100, baked into note timing (see write_midi_clip)",
        },
        notes: { type: "array", items: { type: "object" } },
      },
      required: ["scene_index", "notes"],
    },
  },
  {
    name: "get_clip_notes",
    description: "Read the notes of an arrangement MIDI clip (track_index + clip_index from get_song_overview order).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number" },
      },
      required: ["clip_index"],
    },
  },
  {
    name: "set_clip_notes",
    description: "Replace all notes of an existing arrangement MIDI clip. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number" },
        notes: { type: "array", items: { type: "object" } },
      },
      required: ["clip_index", "notes"],
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
        track_name: { type: "string", description: TRACK_NAME_DESC },
        volume: { type: "number" },
        pan: { type: "number" },
      },
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
- Track indices SHIFT when tracks are added, removed or reordered (by you or the user). On every track tool call, pass track_name (copied from get_song_overview) together with the index — the server verifies the pair and re-resolves by name when the index has drifted, so a stale index never hits the wrong track.
- You CAN adjust device parameters (Operator, Reverb, Auto Filter, …) and track volume/pan — see the device-control section below.
- You cannot delete tracks or scenes, load third-party plugins, or do realtime audio/MIDI processing. Say so if asked. (arrange_song CAN clear clips in a bar range as part of arranging.)
- After tools run, confirm what changed in one short sentence.
- Mutating tool results carry a "verified" flag: the server re-read the Set and checked the change actually landed (value, device, clip). If verified:false comes back with an error, the action DID execute but missed the target — do NOT re-run the same call blindly (that would duplicate content); correct it using the reported actual state, or tell the user what mismatch you see.
- NEVER claim you changed the Live Set unless a tool actually performed the change in THIS turn. If you did not call a tool, nothing changed — do not pretend otherwise.

Goals (tasks that change the Set):
- When the user asks for a musical change — create, edit, arrange, mix, sound design, fix — call set_goal FIRST, before any Set-modifying tool, declaring machine-checkable successCriteria for what "done" means. Questions, analysis requests and single-knob tweaks do NOT need one.
- Criteria are a CLOSED vocabulary (see the set_goal schema): pick a kind and fill its parameters. Section names come from analyze_song; "baseline:<name>" compares a section against its state at the moment you declared the goal. Never invent kinds.
- set_goal snapshots the Set as its baseline. When you stop calling tools, the server evaluates every criterion against the new state. Unmet criteria come back as a 目标校验 message — keep working or explain the blocker; NEVER claim completion while criteria are unmet.
- Write 1–4 criteria that genuinely define the outcome ("make the drop harder" → section_energy_gt Drop vs baseline:Drop + role_present low_end in Drop). The objective sentence is for humans; only criteria are judged.
- set_goal's result includes a music block: measured features and observations relevant to your declared goal (target section/track energy, density, rhythmic activity, contrasts like Build→Drop, repetition like Drop 1↔Drop 2, each observation with its evidence chain). Base your criteria thresholds and set_plan steps on THESE numbers — cite them, never guess them. A missing key means "no data" (e.g. audio not analyzed), not zero.
- The music block may also include actions: evidence-backed CANDIDATE musical interventions derived from the current Set (e.g. introduce_variation on Drop 2 when it repeats Drop 1 with no evolution). Treat them as planning hints, never as mandatory instructions — pick only the ones that serve the user's goal, translate each chosen action into concrete set_plan steps with the available tools, and never invent musical problems the block does not evidence. Not every action needs a plan step, and no action executes anything by itself.
- set_goal's result may include a section block: the resolved TARGET section (id, name, beat range, match confidence), up to 3 comparison REFERENCES (previous/next/same-role/reprise/contrast partners with their similarity/contrast numbers), and only the features/observations/actions relevant to that target. Rules when it is present: (1) the target is your primary edit scope — keep set_plan steps inside its beat range whenever possible; (2) references are for COMPARISON, not automatic edit targets — modify a neighbor/reference only when the goal is relative (contrast/transition, e.g. "make the drop hit harder" may justify thinning the Build) and say why in the step description; (3) prefer the supplied actions as intervention directions and never edit unrelated sections unless the goal demands it. If the goal check retries with a 段落校验 line naming a section metric that missed (before→after), fix THAT metric in THAT section — do not switch to a different section.
- set_goal's result may include a reference block (the user gave a REFERENCE TRACK): the aligned reference section and the measured gaps between it and your target section (delta = reference − current) plus conservative action hints. Rules when it is present: (1) reference differences are GUIDANCE, not absolute correctness — use them only where they serve the user's stated goal, and the user goal always wins on conflict; (2) never try to reproduce the reference literally — no copying, no cloning, no "make it identical"; (3) prefer the supplied actions when they explain a gap; (4) do not modify unrelated sections merely to match the reference; (5) a small gap (dir "similar") is NOT a problem — do not "fix" it; (6) if the goal check retries with a 参考校验 line, keep narrowing the NAMED gaps inside the SAME target section.
- The audio criteria (track_crest_gte, track_band_gte) judge the track's clip SOURCE FILES — mixer/EQ/compressor/warp edits never move them; only replacing the sample does. Declare them only for sound-design tasks where swapping the sample is a valid route ("kick 没冲击力" → track_crest_gte Kick ≈ 6 dB via search_samples/generate_audio replacement), never for processing-only tasks.

Plans (multi-step tasks):
- After set_goal, when the task needs 2+ tool calls or multiple stages, call set_plan with your ordered steps BEFORE touching the Set. Each step: a short description, the tool you expect to call, and expectedEffects — what the step should measurably change (closed vocabulary, see the set_plan schema).
- expectedEffects are your own predictions ("add hats" → section_energy increase in Drop). The server checks them against the measured Set at the end. If the goal check fails, the 目标校验 message includes a 计划诊断: which steps never executed (matched from your actual tool calls, not your claims) and which predicted effects were not observed — fix THAT step instead of re-running calls that already landed.
- A step may declare scope {section, startBeat, endBeat} marking the musical region it edits (use the target section from set_goal's section block) — metadata that keeps multi-section tasks honest, not a sandbox. Omit it for song-wide steps.
- Skip set_plan for single-call tweaks. Declaring a plan never modifies the Set.

Loop bounds (hard, server-enforced):
- One turn executes at most 8 Set-modifying tool calls — beyond that the server refuses further mutations UNEXECUTED. If you hit the budget, stop modifying, summarize what landed vs. what remains, and let the user say "continue" (a new turn = a fresh budget).
- A failed goal check gets exactly ONE retry; the plan is then cleared — re-plan the remaining gap from the diagnosis instead of re-running the route that missed. There is no open-ended tweak loop: if the check fails again, the turn ends and the user sees the server's measured state.

Making music that actually produces sound:
- A MIDI track without an instrument is SILENT, and a bare "Drum Rack" is EMPTY and silent too.
- For drums: ALWAYS call load_drum_kit(track_index) — it loads Ableton's factory 808 samples into a Drum Rack. Pad pitches: 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 75=Clave. Write MIDI with exactly these pitches.
- For bass/melody/pads: insert "Operator" or "Wavetable" (both audible immediately). Wavetable sound design: use get_device_parameters with filters like "wavetable" (position), "osc", "unison", "filter" then set_device_parameter.
- For sample playback: load_sample into a Simpler (then tweak its params freely). NEVER insert "Sampler" — samples cannot be loaded into it via the API, so it stays silent.
- Then write notes with write_midi_clip (arrangement) or write_session_clip (session). Times are in beats: in 4/4, bar = 4 beats, 4 bars = 16 beats.
- Classic 4-bar techno pattern: kick (36) on every beat 0..15; clap (39) or snare (38) on beats 1 and 3 of each bar (i.e. 1,3,5,7...); closed hat (42) on offbeats 0.5,1.5,...; open hat (46) sparingly; toms (41/43/45) as fills in the last bar. Vary velocity for groove.
- After writing, remind the user to press play / trigger the clip to hear it.

Sequencing an Ableton Move (hardware) from Live:
- Workflow: create_move_track(channel) → relay the returned routing steps to the user verbatim (the SDK cannot set output routing; it is a one-time manual step per Set) → then write clips into that track as usual.
- Requirements: Move firmware ≥1.5, Standalone Mode (NOT Control Live Mode), USB-C to the computer. If "Ableton Move" doesn't appear as a MIDI port on macOS, the user may need to delete a stale entry in Audio MIDI Setup → MIDI Studio and reconnect.
- Move receives notes, velocity, poly aftertouch and MIDI clock; MIDI CC does NOT reach it — never promise CC automation on Move.
- Move drum pads follow the Drum Rack layout starting at note 36 (C1); melodic tracks play normal pitched notes.
- For tempo sync without MIDI clock, Ableton Link over WiFi also works (Live and Move on the same network).

Move file transfer (WiFi, stock firmware API — pairing required once):
- Pair: move_pair (no code) → the Move shows a 6-digit code on its display → ask the user for it → move_pair({code}). The token persists across sessions; if a call fails with 401, pair again.
- move_list_sets / move_list_files browse the device; move_upload_sample sends a local audio file to the Move (default folder "Samples"), move_download_set pulls a Set (.ablbundle) into the User Library's AIbleton folder.
- move_analyze_set(set_id) downloads a Set AND analyzes it with the same engine as analyze_song (key, track roles, note stats, issues) plus Move extras: per-track mixer levels, device chains, sample list with durations and pack/user origin. Move Sets have no arrangement — all clips are session clips, so use move_analyze_set (not analyze_song) for anything on the device. Great entry point when the user wants to recreate, extend or review a Move Set in Live.
- Typical flow: generate_audio → move_upload_sample → the sample appears under Samples on the Move, ready to load into a drum pad or a melodic track. Say so when it lands.
- move_status reports reachability/pairing/firmware; use it when a Move call fails or the user asks.

Samples and audio files:
- Workflow: search_samples(query) → import_audio_clip (loops/stems onto an audio track's arrangement) or load_sample (one-shots into a Simpler for pitched play).
- search_samples covers the Splice folder if the Splice app is installed and synced, plus Ableton User Library, Factory Packs and Core Library. Splice's online catalog is NOT browsable — only local files.
- search with specific keywords ("deep house loop 124", "909 snare"); if total is huge, refine the query instead of paging.
- search_samples parses BPM ("124 bpm" / bare "124") and key ("Am", "F#") from the query and ranks exact matches first — include them when the user names a tempo or key. Vibe words work too ("dark", "warm", "punchy") via built-in synonyms. The response echoes how the query was parsed — if it misread something (e.g. "124" as BPM when it was a catalog number), rephrase and search again.

AI audio generation:
- Priority rule: NEVER call generate_audio speculatively. Call it only when (a) the user explicitly asks to AI-generate/create new audio, or (b) search_samples already ran, found nothing suitable, and the user agreed to generate. For everything else prefer MIDI instruments or local samples — they are free and instant. Every generate_audio call is confirmed by the user before it runs.
- generate_audio(prompt, duration_seconds) creates NEW audio with the configured provider (Stable Audio / ElevenLabs / MiniMax) and saves it into the User Library's "AIbleton" folder. It costs API credits and takes ~10–60 s — write a precise English prompt (genre, BPM, key, mood; add "seamless loop" for loops) and keep loops short (4–16 s).
- Vocals: generated audio is instrumental by default. Only add lyrics when the user explicitly asks for a sung vocal (MiniMax).
- Workflow: generate_audio → import_audio_clip (loops/stems onto an audio track) or load_sample (one-shots into a Simpler). Generated files also become searchable via search_samples afterwards.
- If the tool errors about a missing API key, tell the user to add their key in Settings (gear icon) → 音频生成 / Audio Generation.

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
- Send amounts are not controllable either; volume/pan only via set_track_mixer.

Song analysis (read-only):
- analyze_song gives an engineering-level read of the Set: detected key (Krumhansl, duration-weighted, drums excluded) vs Live's own scale setting, per-track roles (kick/snare/hats/bass/chords/pad/lead/arp/vocal/…) with note/velocity/density/polyphony/entropy stats, section structure (cue points, else 8-bar energy blocks), a session-view summary, and rule-based issues (SINGLE_LOOP, DUPLICATE_CONTENT, LOW_CONTRAST, FLAT_DYNAMICS, MONOTONE_BASS, OFF_KEY, NO_LOW_END/NO_HIGH_END, MUTED_CONTENT, KEY_MISMATCH).
- When the user's question is about how the material SOUNDS ("bass 太薄", "kick 没冲击力", "mix 太闷", "high-end 太刺", "drop 不够大"), call analyze_song with audio:true: it decodes the audio clips' source files (WAV/AIFF) and adds per-track loudness/crest/dynamic-range/6-band energy/transient density plus audio-derived issues (WEAK_TRANSIENTS, THIN_LOW_END, SQUASHED_DYNAMICS, DULL_HIGH_END, HARSH_HIGH_END). Features describe the SOURCE FILE, pre-warp/pre-gain/pre-device — NOT the audible result through the device chain. First run reads files and is slower; results are cached for the session. MIDI-only tracks (synths) have no source file — audio:true analyzes audio clips only.
- When the user's question is about specific material ("the bass is boring", "what's the vocal doing"), pass analyze_song's focus parameter ("bass", "vocal"): focused tracks keep full stats, every section shows whether the focused tracks are active in it (focusTracks), relevant issues sort first, and everything else collapses to one-liners — much cheaper than the full read on large Sets, and the focused tracks' details can't be crowded out. Omit focus for song-wide work (arranging, key/energy overview).
- Call it when the user asks to analyze/review/diagnose the track, before proposing arrangement or structural changes, or when you need key/role context to write a part that fits. It is read-only and needs no confirmation.
- Without audio:true it is MIDI- and structure-based ONLY: audio clips contribute filename + duration. Even with audio:true you are analyzing files, not listening — never claim you listened to the audio.
- Track indices in its output match get_song_overview, so you can follow up with get_clip_notes on a specific track.
- Its clip map lists every clip's coordinates: arrangement clips as (t, i) = (track_index, clip_index) with bar/length, session clips as (t, scene). This is the coordinate system arrange_song plans against.

Arranging the Set:
- Workflow: analyze_song → design the section plan from its clip map and section/role read-out → arrange_song executes the whole plan in ONE call.
- Each arrange_song placement copies a source clip (arrangement clip_index or session scene_index) onto ITS OWN track at start_bar for length_bars. Looping sources tile to fill; one-shots play once. Sources stay untouched.
- The plan is validated before anything changes — a bad reference or same-track overlap aborts with zero writes — and the whole plan lands as a single undo step in Live.
- clear_range_bars wipes ALL tracks' clips in that inclusive bar range first; use it only for rebuilds, never casually. When unsure, call arrange_song with dry_run first and check the resolved plan.
- MIDI clips are baked note-by-note; audio clips reference the same file. Warp markers, fades and automation are NOT carried over, and clips cannot move across tracks — say so when it matters.

Artist memory:
- The user's artist memory (below, when present) is their durable musical identity. Treat it as the default context for every musical suggestion: match their genres, BPM range and sound preferences unless they ask otherwise.
- When the user states a durable preference about THEIR style ("I make techno around 128", "remember: I love 909 drums"), call update_memory to save it — it persists across chats. Do NOT save one-off choices that only apply to the current Set, and never call it speculatively.
- If no memory section appears below, none exists yet — that's fine; don't push the user to create one.

Web access:
- If web_search/web_fetch are NOT among your tools, web access is OFF: NEVER pretend to search or claim you checked something online — say web search is disabled and the user can turn it on in Settings (gear icon) → 联网搜索 / Web Search.`;

/** Appended to the system prompt only when the user enabled web search —
 * weak relay models imitate prompt text, so the ON workflow must not be
 * visible while the tools are withheld. */
const WEB_PROMPT = `

Web access is ON:
- web_search(query) searches the web (free, keyless) and returns title/URL/snippet hits; web_fetch(url) reads one page's text. Both are read-only and run without confirmation.
- Use them for current or external information: software versions and release notes, prices, tutorials, news, facts you don't know, or a URL the user pasted. Don't use them for Ableton how-to you already know or for local files.
- Workflow: web_search → web_fetch the 1–2 most promising hits for details → answer with the source URL(s) so the user can verify.
- If a web tool returns an error or empty/irrelevant results, say the search failed — NEVER invent facts, version numbers, or URLs.`;

/** Web tools leave the tools list entirely when the toggle is off, so the
 * model can't call them (and weak relay models can't imitate them). */
function activeTools(): typeof TOOLS {
  if (webSettings.enabled) return TOOLS;
  return TOOLS.filter((t) => t.name !== "web_search" && t.name !== "web_fetch");
}

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

function matchByName<T extends { name: string }>(items: readonly T[], ref: string, what: string): T {
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
interface TrackRef {
  track: Track<"1.0.0">;
  index: number;
  /** The stale index the caller passed, when it had drifted. */
  refreshedFrom?: number;
}

function resolveTrack(
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
function trackResult(ref: TrackRef, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    track_index: ref.index,
    ...(ref.refreshedFrom !== undefined
      ? { index_refreshed: `轨道索引已漂移（${ref.refreshedFrom} → ${ref.index}），已按名称“${ref.track.name}”重新定位` }
      : {}),
  };
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

/** The Extension Host bridge hands back BigInt for some numeric getters
 * (Scene.signatureNumerator confirmed on real Live 12.4.5) — normalize every
 * number crossing the host boundary or arithmetic blows up downstream. */
function toNum(v: unknown, fallback = 0): number {
  const n = Number(v as number);
  return Number.isFinite(n) ? n : fallback;
}

/** Serialize a Live clip for analyzeSong. `start` is null for session clips. */
function snapshotClip(c: Clip<"1.0.0">, start: number | null): SnapshotClip {
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
function buildSongSnapshot(song: Song<"1.0.0">): SongSnapshot {
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

function requireMovePaired(): void {
  if (!moveSettings.token) {
    throw new Error("Move 尚未配对 — 先调用 move_pair（不带 code）获取屏幕上的配对码。");
  }
}

// ---------- arrange_song ----------

interface ResolvedPlacement {
  ref: TrackRef;
  kind: "midi" | "audio";
  srcName: string;
  srcDesc: string; // e.g. 编排 clip 2“Loop A” / 场景 3“Loop A”
  startBeat: number;
  lenBeats: number;
  name?: string;
  color: number;
  muted: boolean;
  notes: NoteDescription[]; // midi only, already tiled/trimmed to lenBeats
  filePath?: string; // audio only
  isWarped?: boolean;
  loopSettings?: ClipLoopSettings;
  warning?: string;
}

/**
 * Compiles a placement plan into arrangement clips. Everything is resolved
 * and validated (references, overlaps) BEFORE any mutation, so a bad plan
 * fails with zero writes; execution is one transaction = one undo step.
 * Source clips are read into plain data up front — clear_range_bars may
 * delete them, and SDK objects throw once their Live object is gone.
 */
async function arrangeSong(context: Ctx, input: Record<string, unknown>): Promise<unknown> {
  const song = context.application.song;
  const scenes = song.scenes ?? [];
  const num = toNum(scenes[0]?.signatureNumerator) || 4;
  const den = toNum(scenes[0]?.signatureDenominator) || 4;
  const barBeats = (num * 4) / den;
  const round1 = (x: number) => Math.round(x * 10) / 10;

  const rawPlacements = Array.isArray(input.placements) ? input.placements : null;
  if (!rawPlacements) throw new Error("请提供 placements 数组（只清场不传 placements 时传 []）");
  if (rawPlacements.length > 128) {
    throw new Error(`一次最多 128 个 placement（当前 ${rawPlacements.length} 个）——请分段执行`);
  }

  // const (via IIFE) so closures below keep the narrowing.
  const clear = ((): { startBar: number; endBar: number; startBeat: number; endBeat: number } | null => {
    if (input.clear_range_bars === undefined || input.clear_range_bars === null) return null;
    const cr = input.clear_range_bars;
    if (!Array.isArray(cr) || cr.length !== 2) {
      throw new Error("clear_range_bars 须为 [起始小节, 结束小节]（含端点）");
    }
    const a = Number(cr[0]);
    const b = Number(cr[1]);
    if (!(a >= 1) || !(b >= a)) throw new Error("clear_range_bars 须满足 1 ≤ 起始小节 ≤ 结束小节");
    return { startBar: a, endBar: b, startBeat: (a - 1) * barBeats, endBeat: b * barBeats };
  })();
  if (rawPlacements.length === 0 && !clear) {
    throw new Error("placements 为空且未给 clear_range_bars —— 无事可做");
  }

  // ---- Phase 1: resolve + read every source into plain data ----
  const problems: string[] = [];
  const resolved: ResolvedPlacement[] = [];

  rawPlacements.forEach((raw, pi) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const label = `placement ${pi + 1}`;
    const startBar = Number(p.start_bar);
    const lenBars = Number(p.length_bars);
    if (!(startBar >= 1)) {
      problems.push(`${label}: start_bar 须 ≥ 1（1 起计）`);
      return;
    }
    if (!(lenBars > 0)) {
      problems.push(`${label}: length_bars 须 > 0`);
      return;
    }
    const hasArr = typeof p.clip_index === "number";
    const hasSes = typeof p.scene_index === "number";
    if (hasArr === hasSes) {
      problems.push(`${label}: clip_index（编排区源）与 scene_index（Session 源）必须且只能给一个`);
      return;
    }
    let ref: TrackRef;
    try {
      ref = resolveTrack(context, p, "track_index");
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message}`);
      return;
    }
    const track = ref.track;

    let clip: Clip<"1.0.0"> | null | undefined;
    let srcDesc: string;
    if (hasArr) {
      const ci = Number(p.clip_index);
      clip = track.arrangementClips[ci];
      if (!clip) {
        problems.push(
          `${label}: 轨道 ${ref.index}（${track.name}）上没有编排 clip ${ci}（共 ${track.arrangementClips.length} 个，0 起计）`,
        );
        return;
      }
      srcDesc = `编排 clip ${ci}`;
    } else {
      const si = Number(p.scene_index);
      clip = track.clipSlots[si]?.clip;
      if (!clip) {
        problems.push(`${label}: 轨道 ${ref.index}（${track.name}）的场景 ${si} 是空槽`);
        return;
      }
      srcDesc = `场景 ${si}`;
    }

    const rp: ResolvedPlacement = {
      ref,
      kind: "midi",
      srcName: String(clip.name ?? ""),
      srcDesc: `${srcDesc}“${clip.name}”`,
      startBeat: (startBar - 1) * barBeats,
      lenBeats: lenBars * barBeats,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined,
      color: toNum(clip.color),
      muted: !!clip.muted,
      notes: [],
    };

    if (clip instanceof MidiClip) {
      const snap = snapshotClip(clip, hasArr ? toNum(clip.startTime) : null);
      rp.kind = "midi";
      rp.notes = tileClipNotes(snap, rp.lenBeats).map((n) => ({
        pitch: n.pitch,
        startTime: n.start,
        duration: n.duration,
        velocity: n.velocity,
      }));
      if (rp.notes.length === 0) rp.warning = "源 clip 没有可闻音符，将创建空 clip";
    } else if (clip instanceof AudioClip) {
      rp.kind = "audio";
      rp.filePath = String(clip.filePath ?? "");
      if (!rp.filePath) {
        problems.push(`${label}: ${rp.srcDesc} 没有文件路径，无法复制`);
        return;
      }
      rp.isWarped = !!clip.warping;
      rp.loopSettings = {
        looping: !!clip.looping,
        startMarker: toNum(clip.startMarker),
        endMarker: toNum(clip.endMarker),
        loopStart: toNum(clip.loopStart),
        loopEnd: toNum(clip.loopEnd),
      };
    } else {
      problems.push(`${label}: ${rp.srcDesc} 类型不受支持`);
      return;
    }
    resolved.push(rp);
  });

  // ---- Phase 2: overlap check (per track): plan vs plan, plan vs what
  // survives the cleared range. Existing clips are trimmed virtually. ----
  if (problems.length === 0) {
    interface Iv {
      s: number;
      e: number;
      what: string;
    }
    const perTrack = new Map<number, Iv[]>();
    const push = (ti: number, iv: Iv) => {
      const list = perTrack.get(ti) ?? [];
      list.push(iv);
      perTrack.set(ti, list);
    };
    song.tracks.forEach((t, ti) => {
      for (const c of t.arrangementClips) {
        const s = toNum(c.startTime);
        const e = toNum(c.endTime);
        let segs = [{ s, e }];
        if (clear) {
          segs = segs.flatMap((g) => {
            if (g.e <= clear.startBeat || g.s >= clear.endBeat) return [g];
            const out: { s: number; e: number }[] = [];
            if (g.s < clear.startBeat) out.push({ s: g.s, e: clear.startBeat });
            if (g.e > clear.endBeat) out.push({ s: clear.endBeat, e: g.e });
            return out;
          });
        }
        for (const g of segs) {
          if (g.e - g.s > 1e-9) push(ti, { ...g, what: `已有 clip“${c.name}”` });
        }
      }
    });
    resolved.forEach((r, pi) => {
      push(r.ref.index, {
        s: r.startBeat,
        e: r.startBeat + r.lenBeats,
        what: `placement ${pi + 1}（${r.srcDesc}）`,
      });
    });
    const bar = (b: number) => round1(b / barBeats + 1);
    for (const [ti, ivs] of perTrack) {
      ivs.sort((a, b2) => a.s - b2.s);
      let maxE = -Infinity;
      let maxWhat = "";
      for (const iv of ivs) {
        if (iv.s < maxE - 1e-9) {
          problems.push(
            `轨道 ${ti}（${song.tracks[ti]?.name ?? "?"}）：${maxWhat} 与 ${iv.what} 在小节 ${bar(iv.s)} 附近重叠——同一轨道的编排 clip 不能重叠`,
          );
        }
        if (iv.e > maxE) {
          maxE = iv.e;
          maxWhat = iv.what;
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`编排计划未通过校验，未对 Set 做任何改动：\n- ${problems.join("\n- ")}`);
  }

  // ---- What clear_range_bars would remove (reported in both dry_run and real run) ----
  let clearInfo: Record<string, unknown> | null = null;
  if (clear) {
    let affected = 0;
    const tracksHit = new Set<number>();
    song.tracks.forEach((t, ti) => {
      for (const c of t.arrangementClips) {
        const s = toNum(c.startTime);
        const e = toNum(c.endTime);
        if (e > clear.startBeat && s < clear.endBeat) {
          affected++;
          tracksHit.add(ti);
        }
      }
    });
    clearInfo = { range_bars: [clear.startBar, clear.endBar], clips_affected: affected, tracks: tracksHit.size };
  }

  const planOut = resolved.map((r, pi) => ({
    placement: pi + 1,
    track_index: r.ref.index,
    track: r.ref.track.name,
    source: r.srcDesc,
    start_bar: round1(r.startBeat / barBeats + 1),
    length_bars: round1(r.lenBeats / barBeats),
    kind: r.kind,
    ...(r.kind === "midi" ? { notes: r.notes.length } : {}),
    name: r.name ?? r.srcName,
    ...(r.ref.refreshedFrom !== undefined
      ? { index_refreshed: `轨道索引已漂移（${r.ref.refreshedFrom} → ${r.ref.index}），已按名称重新定位` }
      : {}),
    ...(r.warning ? { warning: r.warning } : {}),
  }));

  if (input.dry_run === true) {
    return {
      dry_run: true,
      bar_beats: barBeats,
      ...(clearInfo ? { would_clear: clearInfo } : {}),
      placements: planOut,
      note: "校验通过，未改动 Set —— 去掉 dry_run 再调用即执行",
    };
  }

  // ---- Phase 3: execute — one transaction, one undo step ----
  await context.withinTransaction(async () => {
    if (clear) {
      for (const t of song.tracks) {
        await t.clearClipsInRange(clear.startBeat, clear.endBeat);
      }
    }
    for (const r of resolved) {
      if (r.kind === "midi") {
        const track = r.ref.track;
        if (!(track instanceof MidiTrack)) {
          throw new Error(`轨道 ${r.ref.index}（${track.name}）不是 MIDI 轨道`);
        }
        const clip = await track.createMidiClip(r.startBeat, r.lenBeats);
        clip.notes = r.notes;
        clip.name = r.name ?? r.srcName;
        if (r.color) clip.color = r.color;
        if (r.muted) clip.muted = true;
      } else {
        const track = r.ref.track;
        if (!(track instanceof AudioTrack)) {
          throw new Error(`轨道 ${r.ref.index}（${track.name}）不是音频轨道`);
        }
        // isWarped + loopSettings always travel together (SDK requires
        // isWarped whenever loopSettings is given); both are read from the
        // source clip, so the pair is always consistent.
        const clip = await track.createAudioClip({
          filePath: r.filePath as string,
          startTime: r.startBeat,
          duration: r.lenBeats,
          isWarped: r.isWarped ?? false,
          loopSettings: r.loopSettings,
        });
        clip.name = r.name ?? r.srcName;
        if (r.color) clip.color = r.color;
        if (r.muted) clip.muted = true;
      }
    }
  });

  return {
    arranged: true,
    bar_beats: barBeats,
    ...(clearInfo ? { cleared: clearInfo } : {}),
    placements: planOut,
    clips_created: resolved.length,
    undo: "整个计划是一个事务——在 Live 里按一次 ⌘Z 即可全部撤销",
  };
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
    case "analyze_song": {
      // Three-stage: facts (what is in the Set) -> interpretation (what it
      // means) -> presentation (model-bound JSON, budget-fitted). Optional
      // focus runs the Context Selector between interpretation and
      // presentation (select.ts) for a focused projection. audio:true inserts
      // async source-file enrichment between facts and interpretation
      // (audiofiles.ts) — buildMusicState itself stays sync and pure.
      const state = buildMusicState(buildSongSnapshot(song));
      const audioRun =
        input.audio === true ? await enrichMusicStateWithAudio(state) : undefined;
      const ma = analyzeMusicState(state);
      const focus =
        typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : undefined;
      return presentAnalysis(
        state,
        ma,
        5800,
        focus ? selectMusicContext(state, ma, focus) : undefined,
        audioRun,
      );
    }
    case "set_goal": {
      return handleSetGoal(context, input);
    }
    case "set_plan": {
      return handleSetPlan(context, input);
    }
    case "arrange_song": {
      return arrangeSong(context, input);
    }
    case "update_memory": {
      // Partial update: only fields present in input are touched; "" / [] / 0
      // clear a field. Writes memory.json next to providers.json.
      const p = artistMemory;
      if (typeof input.name === "string") p.name = input.name.trim() || undefined;
      if (input.genres !== undefined) p.genres = toStrArr(input.genres);
      if (input.keys !== undefined) p.keys = toStrArr(input.keys);
      if (input.sound !== undefined) p.sound = toStrArr(input.sound);
      if (input.artists !== undefined) p.artists = toStrArr(input.artists);
      if (typeof input.notes === "string") p.notes = input.notes.trim() || undefined;
      if (input.bpmMin !== undefined) {
        const v = toBpm(input.bpmMin);
        if (Number(input.bpmMin) !== 0 && v === undefined) throw new Error("bpmMin 需在 20–999 之间（0 表示清除）");
        p.bpmMin = v;
      }
      if (input.bpmMax !== undefined) {
        const v = toBpm(input.bpmMax);
        if (Number(input.bpmMax) !== 0 && v === undefined) throw new Error("bpmMax 需在 20–999 之间（0 表示清除）");
        p.bpmMax = v;
      }
      if (p.bpmMin && p.bpmMax && p.bpmMin > p.bpmMax) {
        [p.bpmMin, p.bpmMax] = [p.bpmMax, p.bpmMin];
      }
      artistMemory = p;
      saveArtistMemory();
      // Return the merged memory so the model sees (and can quote) the result.
      return { saved: true, memory: artistMemory };
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
    case "create_move_track": {
      const channel = Math.min(16, Math.max(1, Math.round(Number(input.channel) || 1)));
      const track = await context.withinTransaction(() => song.createMidiTrack());
      track.name = String(input.name || `Move Ch ${channel}`);
      return {
        created: track.name,
        type: "MIDI",
        routing_setup_required:
          `One-time manual routing (the SDK cannot set this): 1) In Live, set this track's Output Type to "Ableton Move" and Output Channel to ${channel}. ` +
          `2) On Move: firmware ≥1.5, Standalone Mode (NOT Control Live), USB-C to this computer; hold Shift + press a track button and set that track's MIDI In to channel ${channel} (or Auto). ` +
          `Notes, velocity and poly aftertouch reach Move; MIDI CC does not. From then on, any clip you write into this track plays on Move.`,
      };
    }
    case "move_status": {
      try {
        const version = await systemVersion(moveSettings);
        return { connected: true, paired: true, host: moveHost(moveSettings), firmware: version };
      } catch (e) {
        if (e instanceof MoveError && e.status === 401) {
          return {
            connected: true,
            paired: false,
            host: moveHost(moveSettings),
            hint: "设备可达，但尚未配对 — 调用 move_pair（不带 code）让 Move 显示配对码。",
          };
        }
        throw e;
      }
    }
    case "move_pair": {
      const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : undefined;
      if (host) moveSettings.host = host;
      const code = typeof input.code === "string" ? input.code.trim() : "";
      if (!code) {
        await pairStart(moveSettings);
        return {
          pairing: "code_shown",
          message:
            "Move 屏幕上现在显示一个 6 位配对码。请让用户报出这串数字，然后用 move_pair({ code }) 完成配对。",
        };
      }
      moveSettings.token = await pairComplete(moveSettings, code);
      saveManualConfigs();
      return { paired: true, host: moveHost(moveSettings) };
    }
    case "move_list_sets": {
      requireMovePaired();
      return { sets: await listSets(moveSettings) };
    }
    case "move_list_files": {
      requireMovePaired();
      const dir = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
      return { path: dir ?? "/", entries: await listFiles(moveSettings, dir) };
    }
    case "move_upload_sample": {
      requireMovePaired();
      const filePath = String(input.file_path || "");
      if (!filePath) throw new Error("file_path 不能为空");
      const folder =
        typeof input.folder === "string" && input.folder.trim() ? input.folder.trim() : "Samples";
      const result = await uploadFile(moveSettings, filePath, folder, input.overwrite === true);
      return {
        ...result,
        message: `${result.uploaded} 已上传到 Move 的 ${result.folder} 文件夹（${Math.round(result.size / 1024)} KB）— 在 Move 上即可找到，可装入鼓垫或旋律轨道。`,
      };
    }
    case "move_download_set": {
      requireMovePaired();
      const setId = String(input.set_id || "");
      if (!setId) throw new Error("set_id 不能为空");
      const { filename, data } = await downloadSet(moveSettings, setId);
      const dir = generatedAudioDir();
      mkdirOutsideSandbox(dir);
      const target = path.join(dir, filename);
      writeHomeBinary(target, data);
      return {
        saved: target,
        size: data.length,
        message: `Set 已下载到 ${target}（${Math.round(data.length / 1024)} KB）。`,
      };
    }
    case "move_analyze_set": {
      requireMovePaired();
      const setId = String(input.set_id || "");
      if (!setId) throw new Error("set_id 不能为空");
      const setName = (await listSets(moveSettings)).find((s) => s.id === setId)?.name ?? "";
      const { filename, data } = await downloadSet(moveSettings, setId);
      // Parse from memory first — a corrupt bundle shouldn't leave a file behind.
      const bundle = parseMoveBundle(data);
      const dir = generatedAudioDir();
      mkdirOutsideSandbox(dir);
      const target = path.join(dir, filename);
      writeHomeBinary(target, data);
      const result = {
        set: setName || filename.replace(/\.ablbundle$/i, ""),
        saved: target,
        ...analyzeSong(
          moveSongToSnapshot(bundle.song),
          5800,
          typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : undefined,
        ),
        move: moveExtras(bundle) as unknown as Record<string, unknown>,
      };
      // analyzeSong fits itself to 5800 — the move extras ride on top of that,
      // so trim them in stages to stay under callTool's 6000-char hard cut.
      const size = () => JSON.stringify(result).length;
      const m = result.move as unknown as {
        samples?: unknown[];
        samplesOmitted?: number;
        tracks?: { files?: unknown; devices?: unknown }[];
      };
      if (size() > 5800 && Array.isArray(m.samples) && m.samples.length > 10) {
        m.samplesOmitted = m.samples.length - 10;
        m.samples = m.samples.slice(0, 10);
      }
      if (size() > 5800) for (const t of m.tracks ?? []) delete t.files;
      if (size() > 5800) for (const t of m.tracks ?? []) delete t.devices;
      return result;
    }
    case "rename_track": {
      const ref = resolveTrack(context, input, "index");
      const oldName = ref.track.name;
      ref.track.name = String(input.name);
      return trackResult(ref, { renamed: oldName, to: ref.track.name });
    }
    case "set_track_state": {
      const ref = resolveTrack(context, input, "index");
      const track = ref.track;
      if (typeof input.mute === "boolean") track.mute = input.mute;
      if (typeof input.solo === "boolean") track.solo = input.solo;
      if (typeof input.arm === "boolean") track.arm = input.arm;
      return trackResult(ref, { track: track.name, mute: track.mute, solo: track.solo, arm: track.arm });
    }
    case "insert_device": {
      const ref = resolveTrack(context, input, "index");
      const track = ref.track;
      const device = await context.withinTransaction(() =>
        track.insertDevice(String(input.device_name), track.devices.length),
      );
      return trackResult(ref, { inserted: device.name, into: track.name });
    }
    case "create_scene": {
      const index = typeof input.index === "number" ? input.index : -1;
      const scene = await context.withinTransaction(() => song.createScene(index));
      if (input.name) scene.name = String(input.name);
      return { created: scene.name };
    }
    case "get_device_parameters": {
      const tref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, tref.index, deviceRefFrom(input));
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
      return trackResult(tref, {
        device: device.name,
        parameterCount: device.parameters.length,
        ...(truncated
          ? { note: `仅返回前 ${cap} 个参数。请用 filter 按名称精确查询（如 "freq"、"reso"、"coarse"、"lfo"）` }
          : {}),
        parameters: params,
      });
    }
    case "set_device_parameter": {
      const tref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, tref.index, deviceRefFrom(input));
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
      return trackResult(tref, { device: device.name, parameter: param.name, value: display, range: [param.min, param.max] });
    }
    case "set_track_mixer": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const out: Record<string, unknown> = { track: track.name };
      if (typeof input.volume !== "undefined") {
        out.volume = await setParamValue(track.mixer.volume, Number(input.volume));
      }
      if (typeof input.pan !== "undefined") {
        out.pan = await setParamValue(track.mixer.panning, Number(input.pan));
      }
      return trackResult(ref, out);
    }
    case "load_drum_kit": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
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
      return trackResult(ref, { track: track.name, kit: "808", pads });
    }
    case "search_samples": {
      const q = String(input.query ?? "").trim();
      if (!q) throw new Error("query 不能为空");
      return searchSampleIndex(buildSampleIndex(), q, 30);
    }
    case "web_search": {
      // Should be unreachable (the tools list already hides it when off) —
      // this is the safety net, e.g. a stale request mid-toggle.
      if (!webSettings.enabled) {
        throw new Error("联网搜索已关闭：设置(齿轮) → 联网搜索 打开后可用 / Web search is off — enable it in Settings → Web Search");
      }
      const results = await webSearch(String(input.query ?? ""), abortCtl?.signal ?? undefined, activeLanguage);
      return { total: results.length, results };
    }
    case "web_fetch": {
      if (!webSettings.enabled) {
        throw new Error("联网搜索已关闭：设置(齿轮) → 联网搜索 打开后可用 / Web search is off — enable it in Settings → Web Search");
      }
      return await webFetch(String(input.url ?? ""), abortCtl?.signal ?? undefined, activeLanguage);
    }
    case "import_audio_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      if (!(track instanceof AudioTrack)) {
        throw new Error(`轨道 ${ref.index}（${track.name}）不是音频轨道，先用 create_audio_track 建一条`);
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
      return trackResult(ref, { clip: clip.name, file: managed });
    }
    case "load_sample": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
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
      return trackResult(ref, { track: track.name, device: "Simpler", file: managed });
    }
    case "generate_audio": {
      const cfg = activeAudioConfig;
      if (!cfg) {
        throw new Error(
          `未配置音频生成 API Key:设置(齿轮)→ 音频生成 里填所选提供商的 key,或设环境变量 ${audioProviderEnv("stable-audio")} / ${audioProviderEnv("elevenlabs")} / ${audioProviderEnv("minimax")}`,
        );
      }
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const duration = Math.min(190, Math.max(1, Number(input.duration_seconds ?? 8) || 8));
      const file = await generateAudio(
        cfg,
        {
          prompt,
          seconds: duration,
          instrumental: typeof input.instrumental === "boolean" ? input.instrumental : undefined,
          lyrics: typeof input.lyrics === "string" ? input.lyrics : undefined,
        },
        abortCtl?.signal ?? undefined,
      );
      // Let search_samples find the new file without a restart.
      sampleIndex = null;
      return {
        file,
        provider: AUDIO_PROVIDER_NAMES[cfg.provider],
        duration_seconds: duration,
        next: "用 import_audio_clip 放上编排(loop/stem)或 load_sample 装进 Simpler(one-shot)",
      };
    }
    case "write_midi_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = midiTrackAt(context, ref.index);
      const start = Number(input.start_beat ?? 0);
      const length = Number(input.length_beats ?? 16);
      if (!(length > 0)) throw new Error("length_beats 必须大于 0");
      const clip = await context.withinTransaction(() => track.createMidiClip(start, length));
      const notes = applySwing(parseNotes(input.notes, length), Number(input.swing ?? 0)).filter(
        (n) => n.startTime < length,
      );
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return trackResult(ref, { clip: clip.name, start, length, noteCount: notes.length, swing: Number(input.swing ?? 0) });
    }
    case "write_session_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = midiTrackAt(context, ref.index);
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
      return trackResult(ref, { clip: clip.name, length, noteCount: notes.length, swing: Number(input.swing ?? 0) });
    }
    case "get_clip_notes": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      return trackResult(ref, {
        name: clip.name,
        start: clip.startTime,
        duration: clip.duration,
        notes: clip.notes.map((n) => ({
          pitch: n.pitch,
          start: n.startTime,
          duration: n.duration,
          velocity: n.velocity,
        })),
      });
    }
    case "set_clip_notes": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      const notes = parseNotes(input.notes, clip.duration);
      clip.notes = notes;
      return trackResult(ref, { clip: clip.name, noteCount: notes.length });
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

/** Rendered into the system prompt only when a memory exists — an empty
 * memory adds no section at all (same pattern as WEB_PROMPT). */
function memoryPrompt(): string {
  const p = artistMemory;
  const lines: string[] = [];
  if (p.name) lines.push(`- Name: ${p.name}`);
  if (p.genres?.length) lines.push(`- Genres: ${p.genres.join(", ")}`);
  if (p.bpmMin || p.bpmMax) {
    const range = p.bpmMin && p.bpmMax && p.bpmMin !== p.bpmMax
      ? `${p.bpmMin}–${p.bpmMax}`
      : `${p.bpmMin ?? p.bpmMax}`;
    lines.push(`- BPM: ${range}`);
  }
  if (p.keys?.length) lines.push(`- Preferred keys: ${p.keys.join(", ")}`);
  if (p.sound?.length) lines.push(`- Sound: ${p.sound.join(", ")}`);
  if (p.artists?.length) lines.push(`- Reference artists: ${p.artists.join(", ")}`);
  if (p.notes) lines.push(`- Notes: ${p.notes}`);
  if (!lines.length) return "";
  return (
    "\n\nThe user's artist memory (their durable musical identity — these are their defaults unless they say otherwise):\n" +
    lines.join("\n")
  );
}

function systemPromptFor(language?: string): string {
  const name = LANG_NAMES[language ?? ""] ?? "English";
  // The date anchors "latest/recent" web searches — the model's training
  // cutoff alone can't resolve them.
  const today = new Date().toISOString().slice(0, 10);
  return (
    SYSTEM_PROMPT +
    memoryPrompt() +
    (webSettings.enabled ? WEB_PROMPT : "") +
    `\n\nToday's date: ${today}.` +
    `\nThe user's UI language is ${name} — use it as the default reply language unless they write in a different language.`
  );
}

const CUSTOM_INCOMPLETE_HINT: Record<string, string> = {
  zh: "Custom 需要填写 API 地址和模型：设置（齿轮图标）→ Custom（本地服务可留空 API Key）",
  en: "Custom needs a Base URL and a model: Settings (gear icon) → Custom (local servers may leave the API Key empty)",
  de: "Custom benötigt API-Adresse und Modell: Einstellungen (Zahnrad) → Custom (lokale Server können ohne API-Schlüssel laufen)",
  fr: "Custom nécessite une adresse API et un modèle : paramètres (icône engrenage) → Custom (les serveurs locaux peuvent laisser la clé API vide)",
  ja: "Custom には API アドレスとモデルが必要です：設定（歯車アイコン）→ Custom（ローカルサーバーは API キー空欄可）",
  es: "Custom necesita una dirección API y un modelo: Ajustes (icono de engranaje) → Custom (los servidores locales pueden dejar la API Key vacía)",
  it: "Custom richiede un indirizzo API e un modello: Impostazioni (icona ingranaggio) → Custom (i server locali possono lasciare vuota la API Key)",
};

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
    req.provider === "codex" || req.provider === "gemini" || req.provider === "custom"
      ? req.provider
      : "claude";
  // Manual settings-UI config wins over CLI autodetect; per-request fields win over both.
  const local: LocalConfig = { ...(loadLocalConfig(provider) ?? {}), ...(manualConfigs[provider] ?? {}) };
  const fromLocal = !req.apiKey && Boolean(local.authToken || local.apiKey);

  if (provider === "custom") {
    // Generic OpenAI-compatible endpoint (Grok / DeepSeek / Kimi / OpenRouter /
    // Ollama / vLLM …): chat/completions protocol. No CLI autodetect, no
    // effort mapping, no built-in defaults — baseUrl and model are required,
    // the key may stay empty for local servers that don't check it.
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || "").replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || local.authToken || "",
      model: req.model || local.model || "",
      fromLocal,
    };
  }
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
      model: req.model || local.model || "gemini-flash-latest",
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

/** Tools that never touch the Set — always allowed, even with YOLO off.
 * web_search/web_fetch are read-only: free, keyless, and they touch nothing
 * local. update_memory only rewrites the user's own memory.json — local,
 * free and trivially reversible, so it needs no confirmation either. */
const READ_ONLY_TOOLS = new Set([
  "get_song_overview",
  "analyze_song",
  "set_goal",
  "set_plan",
  "update_memory",
  "get_device_parameters",
  "get_clip_notes",
  "search_samples",
  "web_search",
  "web_fetch",
  "move_status",
  "move_pair",
  "move_list_sets",
  "move_list_files",
  "move_analyze_set",
]);

/**
 * Tools that spend real money (API credits). YOLO exempts Set-modifying
 * tools from confirmation, but never these — a billing action always asks.
 */
const COSTLY_TOOLS = new Set(["generate_audio"]);

/** What a costly tool call will spend, shown in the confirm bar. */
function costlyDetail(
  name: string,
  input: Record<string, unknown>,
): { provider: string; duration: number } | undefined {
  if (!COSTLY_TOOLS.has(name)) return undefined;
  return {
    provider: activeAudioConfig ? AUDIO_PROVIDER_NAMES[activeAudioConfig.provider] : "?",
    duration: Math.min(190, Math.max(1, Number(input.duration_seconds ?? 8) || 8)),
  };
}

/**
 * A tool call waiting for the user's Allow/Deny click in the UI (YOLO off).
 * The UI polls /api/status for it and answers via POST /api/confirm.
 */
let pendingConfirm: {
  tool: string;
  input: unknown;
  costly?: { provider: string; duration: number };
  resolve: (allow: boolean) => void;
} | null = null;

/** Ask the user before a Set-modifying tool call; false = denied or timed out. */
function askConfirmation(
  tool: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Safety net: a forgotten dialog must not wedge the background task forever.
    const timer = setTimeout(() => {
      pendingConfirm = null;
      resolve(false);
    }, 300_000);
    pendingConfirm = {
      tool,
      input,
      costly: costlyDetail(tool, input),
      resolve: (allow) => {
        clearTimeout(timer);
        pendingConfirm = null;
        resolve(allow);
      },
    };
  });
}

/** Run one tool call and normalize the result for the provider + UI log. */
/**
 * Deterministic postcondition verification (verify/). After a mutating tool
 * succeeds, checks derived from the call itself are probed against the live
 * Set. Failure keeps the result fields (what actually happened) but adds an
 * `error` key — weak models react to structural errors far more reliably than
 * to advisory text. Never throws: a verifier bug must not fail a working call.
 */
async function verifyToolResult(
  context: Ctx,
  name: string,
  input: Record<string, unknown>,
  result: unknown,
): Promise<unknown> {
  if (typeof result !== "object" || result === null || "error" in result) return result;
  try {
    const specs = postconditionsFor(name, input, result as Record<string, unknown>);
    if (!specs.length) return result;
    // SDK classes carry protected members — the structural ProbeSong view
    // requires one explicit cast here at the boundary.
    const v = await runVerification(context.application.song as unknown as ProbeSong, specs);
    if (v.success) return { ...(result as Record<string, unknown>), verified: true };
    debugLog(context, `VERIFY FAILED ${name}: ${v.remainingIssues.join("；")}`);
    return {
      ...(result as Record<string, unknown>),
      verified: false,
      error:
        `验证失败（操作已执行，未达预期）: ${v.remainingIssues.join("；")}。` +
        `请勿直接重复该操作（避免重复创建内容），按实际状态修正。`,
    };
  } catch (err) {
    debugLog(context, `VERIFY skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}

// ---------- Goal/Intent layer (goal/) ----------
//
// One declared goal per user turn. set_goal captures the baseline view at
// declaration time; when the model stops calling tools, goalGate evaluates
// the criteria and either lets the turn finish, injects a 目标校验 message so
// the loop keeps going (bounded), or — retries exhausted — appends a
// server-side note so the user sees the measured outcome, not the model's
// claim. PR4 verifies single tool calls; this verifies the TASK.
// The bounds (retries, mutation budget, round cap) live in agent/loop.ts.

let pendingGoal: {
  goal: MusicGoal;
  baseline: GoalView;
  /** The music/ stack chained over the SAME state the baseline view was
   * built from — the goal's projected reasoning slice rides the set_goal
   * result so the plan is written against measured evidence (PR13.5). */
  intel: MusicIntelligence;
  /** PR15: the goal's resolved section target + bounded planning context.
   * Absent when the goal names no resolvable section — the loop then runs
   * exactly as before (song-level behavior is the fallback, never a crash). */
  section?: SectionPlanningContext;
  /** PR16: the analyzed reference track (cached across retries — the gate
   * re-derives gaps against the after-state without re-decoding audio, §60).
   * referenceError records WHY no reference rides the goal; neither field
   * ever blocks the plain goal flow (reference is an enhancement, §62). */
  referenceAnalysis?: ReferenceAnalysis;
  referenceError?: ReferenceError;
  /** User-pinned reference section id (set_goal reference.section). */
  referencePinnedSectionId?: string;
  retries: number;
  /** Declared after mutations already happened this turn — relative
   * ("baseline") criteria then compare against a mid-task state. */
  lateBaseline: boolean;
} | null = null;

// ---------- Reference Track Intelligence (music/reference) ----------
//
// A declared reference is analyzed ONCE per file identity and cached for the
// process lifetime (the audiofiles.ts idiom: path+mtime+size keying — best
// effort, §47). The analysis is pure dsp over the decoded bytes; the file
// itself never leaves the machine (§72: local analysis only).

interface ReferenceCacheEntry {
  mtimeMs: number;
  size: number;
  outcome: { analysis: ReferenceAnalysis } | { error: ReferenceError; message?: string };
}

const referenceCache = new Map<string, ReferenceCacheEntry>();

function loadReferenceAnalysis(
  path: string,
  tempoBpm?: number,
): ReferenceCacheEntry["outcome"] {
  let mtimeMs = 0;
  let size: number | null = null;
  try {
    const st = fs.statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    // stat denied (sandbox) or missing — read decides; keying degrades to
    // path-only, same documented trade-off as audiofiles.ts.
  }
  const hit = referenceCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && (size === null || hit.size === size) && tempoBpm === undefined) {
    return hit.outcome;
  }
  const buf = readHomeBinary(path);
  if (!buf) {
    const outcome = { error: "reference_unavailable" as const, message: "unreadable (missing or denied)" };
    referenceCache.set(path, { mtimeMs, size: size ?? 0, outcome });
    return outcome;
  }
  const source: ReferenceSource = { type: "audio_file", path };
  const outcome = analyzeReferenceBuffer(source, buf, { ...(tempoBpm !== undefined ? { tempoBpm } : {}) });
  if (tempoBpm === undefined) {
    referenceCache.set(path, { mtimeMs, size: buf.length, outcome });
  }
  return outcome;
}


/** Mutating calls that actually executed this turn (drives lateBaseline). */
let mutationsThisTurn = 0;

// ---------- Plan layer (plan/) ----------
//
// One declared plan per goal. set_plan attaches ordered steps — each with its
// tool and predicted expectedEffects — to the pending goal. The plan never
// gates (goal criteria alone decide "done"); it DIAGNOSES: when the goal gate
// fails, the retry injection names the steps that never executed and the
// predicted effects that were not observed, so self-correction targets the
// right step. Step execution is inferred server-side from the tool-call log —
// never from the model's own claims.

let pendingPlan: MusicPlan | null = null;

/** Every tool call that actually RAN this turn (denied/thrown excluded;
 * verify-failed INCLUDED — "executed but missed target" is not "never
 * happened"). Replayed against plan steps at declare/gate time. */
let executedToolsThisTurn: string[] = [];

/** Declaring intent (set_goal/set_plan) is not executing a plan step. */
const PLAN_META_TOOLS = new Set(["set_goal", "set_plan"]);

/** Known tool names for plan validation — built once from TOOLS. */
const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

function handleSetPlan(context: Ctx, input: Record<string, unknown>): unknown {
  if (!pendingGoal) {
    throw new Error("set_plan 需要先声明目标 — 请先调用 set_goal（计划必须挂在目标上）。 / Call set_goal first: a plan belongs to a declared goal.");
  }
  const norm = normalizePlan(input, VALID_TOOL_NAMES);
  if (!norm.steps) {
    throw new Error(
      `set_plan 未生效：没有有效步骤。` + (norm.warnings.length ? ` ${norm.warnings.join("；")}` : ""),
    );
  }
  const warnings = [...norm.warnings];
  if (mutationsThisTurn > 0) {
    warnings.push(
      `注意：本回合已有 ${mutationsThisTurn} 次改动先于 set_plan 执行 — 计划应在动手之前声明（步骤匹配仍会回放已执行的调用）。`,
    );
  }
  pendingPlan = { goal: pendingGoal.goal, steps: norm.steps };
  // Replay the turn so far: a plan declared late still gets correct statuses.
  const done = executedStepIds(pendingPlan.steps, executedToolsThisTurn);
  debugLog(
    context,
    `PLAN set: ${norm.steps.length} steps for goal「${pendingGoal.goal.objective}」· already executed=${done.size}`,
  );
  return {
    plan_set: true,
    goal: pendingGoal.goal.objective,
    steps: pendingPlan.steps.map((s) => ({
      id: s.id,
      description: s.description,
      ...(s.tool ? { tool: s.tool } : {}),
      effects: s.expectedEffects.length,
      ...(done.has(s.id) ? { already_executed: true } : {}),
    })),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Compact baseline summary for the set_goal tool result — the model reads
 * these numbers when picking thresholds. */
function summarizeView(v: GoalView): Record<string, unknown> {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    tempo: v.tempo,
    key: v.keyBest ?? null,
    trackCount: v.trackCount,
    sections: v.sections.map((s) => ({ name: s.name, bars: s.bars, density: r2(s.density), tracks: s.tracks })),
  };
}

async function handleSetGoal(context: Ctx, input: Record<string, unknown>): Promise<unknown> {
  const norm = normalizeGoal(input);
  if (!norm.goal) {
    throw new Error(
      `set_goal 未生效：没有有效的 successCriteria/constraints。` +
        (norm.warnings.length ? ` ${norm.warnings.join("；")}` : ""),
    );
  }
  const late = mutationsThisTurn > 0;
  const warnings = [...norm.warnings];
  // PR16: an optional reference track rides the goal as comparison evidence.
  // Parsed BEFORE the baseline block so audio enrichment covers a reference
  // comparison too (gaps on audio metrics need the current side decoded).
  const refInput = input.reference as { path?: unknown; section?: unknown; tempo_bpm?: unknown } | undefined;
  const referencePath =
    typeof refInput?.path === "string" && refInput.path.trim() ? refInput.path.trim() : undefined;
  const referencePinned =
    typeof refInput?.section === "string" && refInput.section.trim() ? refInput.section.trim() : undefined;
  const referenceTempo =
    typeof refInput?.tempo_bpm === "number" && refInput.tempo_bpm > 0 ? refInput.tempo_bpm : undefined;
  if (late && !pendingGoal) {
    warnings.push(
      `注意：本回合已有 ${mutationsThisTurn} 次改动先于 set_goal 执行，基线捕获的是改动后的状态 — set_goal 应在任何修改类工具之前调用。`,
    );
  }
  if (pendingPlan) {
    // The goal the plan was built for just changed — the old plan is stale.
    pendingPlan = null;
    warnings.push(`目标已重新声明，之前的计划已清除 — 请重新调用 set_plan。`);
  }
  // Audio criteria judge clip source files: decode them before capturing the
  // baseline so the after-view compares like with like. Cache makes the
  // goalGate re-run nearly free.
  let held = pendingGoal ? { baseline: pendingGoal.baseline, intel: pendingGoal.intel } : null;
  if (!held) {
    const state = buildMusicState(buildSongSnapshot(context.application.song));
    if (goalNeedsAudio(norm.goal) || referencePath) await enrichMusicStateWithAudio(state);
    // Chain the music/ stack over the SAME state the baseline view measures.
    // Roles come from the interpretation layer so a role-named goal resolves
    // against the very labels role_present will judge. Audio features stay
    // undefined unless the goal already needed decoding — the honesty rules
    // carry that through to the projection.
    held = {
      baseline: buildGoalView(state),
      intel: buildMusicIntelligence(state, analyzeMusicState(state)),
    };
  }
  const prevGoal = pendingGoal;
  pendingGoal = {
    goal: norm.goal,
    // Re-declaring within one turn refines the criteria but keeps the
    // ORIGINAL baseline — "what the user asked for this turn" is anchored at
    // the first declaration.
    baseline: held.baseline,
    intel: held.intel,
    // A re-declare without a reference field keeps the previous reference;
    // an explicit new path replaces it below.
    ...(prevGoal?.referenceAnalysis !== undefined ? { referenceAnalysis: prevGoal.referenceAnalysis } : {}),
    ...(prevGoal?.referenceError !== undefined ? { referenceError: prevGoal.referenceError } : {}),
    ...(prevGoal?.referencePinnedSectionId !== undefined
      ? { referencePinnedSectionId: prevGoal.referencePinnedSectionId }
      : {}),
    retries: prevGoal?.retries ?? 0,
    lateBaseline: prevGoal?.lateBaseline ?? late,
  };
  // Reference: load/analyze once (process cache), store on the goal — the
  // gate re-derives gaps against the after-state WITHOUT re-decoding (§60).
  // A failure degrades to a warning; the plain goal flow is untouched (§62).
  if (referencePath) {
    const outcome = loadReferenceAnalysis(referencePath, referenceTempo);
    if ("analysis" in outcome) {
      pendingGoal.referenceAnalysis = outcome.analysis;
      pendingGoal.referenceError = undefined;
      pendingGoal.referencePinnedSectionId = referencePinned;
      debugLog(
        context,
        `REFERENCE analyzed (v${REFERENCE_ANALYZER_VERSION}): ${referencePath}` +
          ` · sections=${outcome.analysis.sections.length} tempo=${outcome.analysis.tempo?.value ?? "?"}` +
          (outcome.analysis.partial ? " · PARTIAL" : ""),
      );
    } else {
      pendingGoal.referenceAnalysis = undefined;
      pendingGoal.referenceError = outcome.error;
      pendingGoal.referencePinnedSectionId = undefined;
      warnings.push(
        `参考音频不可用（${outcome.error}${outcome.message ? `: ${outcome.message}` : ""}）— 目标校验将不使用参考对比，其余流程不受影响。`,
      );
      debugLog(context, `REFERENCE ${outcome.error}: ${referencePath}${outcome.message ? ` · ${outcome.message}` : ""}`);
    }
  }
  // The planner's evidence: the goal's projected slice of the music/ stack,
  // riding the tool result so set_plan is written against measured numbers.
  // Re-declares re-project the STORED intelligence against the NEW goal —
  // the baseline stays anchored, the focus follows the current goal. An
  // intelligence bug must never sink a working goal declaration.
  let music: Record<string, unknown> | undefined;
  try {
    music = presentGoalContext(projectGoalContext(pendingGoal.intel, norm.goal));
  } catch (err) {
    debugLog(context, `INTEL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // PR15: resolve the goal's target SECTION and hand the planner a bounded
  // context (target + comparison references + only the relevant features/
  // observations/actions). Unresolved targets stay absent — the song-level
  // music block above is the fallback, never a fabricated section.
  let section: Record<string, unknown> | undefined;
  let reference: Record<string, unknown> | undefined;
  try {
    let sctx = buildSectionPlanningContext(norm.goal, pendingGoal.intel);
    // PR16: with a reference on the goal, derive the comparison against the
    // RESOLVED target (alignment → gaps → conservative actions) and rebuild
    // the context so the reference block rides it. No alignment → no block.
    if (sctx && pendingGoal.referenceAnalysis) {
      const refIntel = buildReferenceIntelligence(
        pendingGoal.referenceAnalysis,
        pendingGoal.intel.features.sections,
        {
          targetSectionId: sctx.target.sectionId,
          ...(pendingGoal.referencePinnedSectionId
            ? { referenceSectionId: pendingGoal.referencePinnedSectionId }
            : {}),
        },
      );
      sctx = buildSectionPlanningContext(norm.goal, { ...pendingGoal.intel, reference: refIntel }) ?? sctx;
      if (sctx.reference) {
        reference = presentReferencePlanningContext(sctx.reference);
        const meaningful = sctx.reference.gaps.filter(
          (g) => g.direction === "higher_in_reference" || g.direction === "lower_in_reference",
        );
        debugLog(
          context,
          `REFERENCE aligned: ${sctx.target.name} → ${sctx.reference.referenceSectionId}` +
            (meaningful.length
              ? ` · gaps=${meaningful.map((g) => `${g.metric}${g.delta !== undefined ? (g.delta >= 0 ? "+" : "") + g.delta : ""}`).join(",")}`
              : " · no meaningful gaps") +
            (sctx.reference.actions.length
              ? ` · actions=${sctx.reference.actions.map((a) => a.kind).join(",")}`
              : ""),
        );
      } else {
        debugLog(context, `REFERENCE no alignment: ${sctx.target.name} — reference block omitted`);
      }
    }
    if (sctx) {
      pendingGoal.section = sctx;
      section = presentSectionPlanningContext(sctx);
      debugLog(
        context,
        `SECTION target: ${sctx.target.name} (id=${sctx.target.sectionId}, match=${sctx.target.match}, conf=${sctx.target.confidence})` +
          (sctx.references.length
            ? ` · refs=${sctx.references.map((r) => `${r.name}(${r.reason})`).join(",")}`
            : ""),
      );
    } else {
      pendingGoal.section = undefined;
      if (norm.goal.target?.section) {
        debugLog(context, `SECTION unresolved: 「${norm.goal.target.section}」 — falling back to song-level context`);
      }
    }
  } catch (err) {
    pendingGoal.section = undefined;
    debugLog(context, `SECTION failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  debugLog(
    context,
    `GOAL set (${norm.goal.type}): ${norm.goal.objective} · criteria=${norm.goal.successCriteria.length} constraints=${norm.goal.constraints.length}`,
  );
  return {
    goal_set: true,
    type: norm.goal.type,
    objective: norm.goal.objective,
    criteria: norm.goal.successCriteria.length,
    constraints: norm.goal.constraints.length,
    baseline: summarizeView(pendingGoal.baseline),
    ...(music ? { music } : {}),
    ...(section ? { section } : {}),
    ...(reference ? { reference } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

type GoalGateResult = { inject: string } | { appendNote: string } | null;

const GOAL_RETRY_TAIL: Record<string, string> = {
  zh: "请继续调用工具直到标准满足；若确实无法满足，向用户如实说明卡在哪一步。禁止在标准未满足时声称已完成。 / Keep working until the criteria pass, or tell the user honestly what is blocking you — do NOT claim completion while they are unmet.",
  en: "Keep working until the criteria pass, or tell the user honestly what is blocking you — do NOT claim completion while they are unmet.",
};

/** Plan diagnosis appended to goal-gate messages: which steps never ran and
 * which predicted effects didn't materialize — the retry's self-correction
 * target. Empty when the plan fully executed and every effect was observed. */
function planDiagnosisLines(report: PlanReport): string[] {
  const lines: string[] = [];
  const unexecuted = report.unexecuted.map(
    (s) => `${s.id}「${s.description}」${s.tool ? ` (${s.tool})` : ""}`,
  );
  if (unexecuted.length) lines.push(`计划中未执行的步骤：${unexecuted.join("；")}`);
  const missed = report.unobserved.map(
    (fx) => `${fx.stepId}「${fx.description}」: 期望 ${fx.expected}${fx.actual ? `，实际 ${fx.actual}` : ""}`,
  );
  if (missed.length) lines.push(`预期效果未观察到：${missed.join("；")}`);
  if (lines.length) lines.unshift(`【计划诊断 / Plan】已执行 ${report.executedCount}/${report.total} 步：`);
  return lines;
}

/** PR15 section verdict as retry-message lines lives in the sections layer
 * (presentSectionVerification) — the retry's self-correction surface is the
 * layer's own presentation, tested with the layer. */
function goalRetryMessage(
  goal: MusicGoal,
  ev: GoalEvaluation,
  retries: number,
  language?: string,
  plan?: PlanReport,
  replanned?: boolean,
  sectionVer?: SectionVerification,
  sectionName?: string,
  referenceLines?: string[],
): string {
  const lines: string[] = [
    `【目标校验 / Goal check】第 ${retries}/${AGENT_MAX_RETRIES} 次校验，目标「${goal.objective}」尚未达成：`,
  ];
  if (ev.constraintIssues.length) lines.push(`约束违反：${ev.constraintIssues.join("；")}`);
  if (ev.criteriaIssues.length) lines.push(`未达成标准：${ev.criteriaIssues.join("；")}`);
  if (plan) lines.push(...planDiagnosisLines(plan));
  if (sectionVer && sectionName) lines.push(...presentSectionVerification(sectionVer, sectionName));
  if (referenceLines?.length) lines.push(...referenceLines);
  if (replanned) {
    // The loop's single retry IS the replan: the old route already missed, so
    // it is cleared rather than re-run. A fresh focused plan is invited, not
    // required — a one-call fix may go directly.
    lines.push(
      `原计划已清除 — 请根据以上诊断重新声明一个聚焦剩余差距的 set_plan（差距很小也可直接修复）。` +
        ` / The previous plan has been cleared — re-declare a focused set_plan for the remaining gap (or fix it directly if small).`,
    );
  }
  lines.push(GOAL_RETRY_TAIL[language ?? ""] ?? GOAL_RETRY_TAIL.zh);
  return lines.join("\n");
}

const GOAL_UNMET_NOTE: Record<string, string> = {
  zh: `\n\n⚠️ 目标校验未通过（系统已重试 ${AGENT_MAX_RETRIES} 次）：`,
  en: `\n\n⚠️ Goal check failed (retried ${AGENT_MAX_RETRIES}× by the server): `,
};

function goalUnmetNote(
  ev: GoalEvaluation,
  language?: string,
  plan?: PlanReport,
  sectionVer?: SectionVerification,
  sectionName?: string,
  referenceLines?: string[],
): string {
  const head = GOAL_UNMET_NOTE[language ?? ""] ?? GOAL_UNMET_NOTE.zh;
  const issues = [...ev.constraintIssues, ...ev.criteriaIssues].join("；");
  const planLines = plan ? planDiagnosisLines(plan) : [];
  if (sectionVer && sectionName) planLines.push(...presentSectionVerification(sectionVer, sectionName));
  if (referenceLines?.length) planLines.push(...referenceLines);
  const tail =
    (language ?? "").startsWith("zh") || !language
      ? "。以上为系统对 Live Set 的实际检测结果，与上文表述如有出入以检测结果为准。"
      : ". This is the server's measured state of the Live Set — trust it over the text above.";
  return `${head}${issues}${planLines.length ? `\n${planLines.join("\n")}` : ""}${tail}`;
}

/** Evaluate the pending goal at a loop's text-exit. Returns what the loop
 * should do: inject a retry message and continue, or append a note and
 * finish. Never throws — a goal-layer bug must not break a working chat. */
async function goalGate(context: Ctx, language?: string): Promise<GoalGateResult> {
  const held = pendingGoal;
  if (!held) return null;
  try {
    // Rebuild the after-view against the current Set; when the goal (or a
    // plan built on it) judges source-file audio, decode first — the feature
    // cache makes this nearly free after the set_goal baseline run.
    const afterState = buildMusicState(buildSongSnapshot(context.application.song));
    if (goalNeedsAudio(held.goal) || (pendingPlan && planNeedsAudio(pendingPlan)) || held.referenceAnalysis) {
      await enrichMusicStateWithAudio(afterState);
    }
    const after = buildGoalView(afterState);
    const ev = evaluateGoal(held.goal, held.baseline, after);
    // Plan diagnosis rides the SAME before/after views, so a plan effect and
    // a goal criterion can never disagree about the numbers. The plan never
    // gates: a met goal clears it silently (debugLog only).
    const plan = pendingPlan
      ? buildPlanReport(pendingPlan, executedToolsThisTurn, held.baseline, after)
      : null;
    // PR15: when the goal resolved a target section, re-analyze THAT section
    // and judge the before/after change against goal-aware criteria. One
    // extra intelligence chain per gate (§77: before once, after once — never
    // per tool call). The goal gate stays the final authority; this verdict
    // is EVIDENCE for the retry message, not a second gate. A section-layer
    // bug must never sink the gate.
    let sectionVer: SectionVerification | undefined;
    let referenceLines: string[] = [];
    if (held.section) {
      try {
        const afterIntel = buildMusicIntelligence(afterState, analyzeMusicState(afterState));
        sectionVer = verifySectionChange(held.section, held.intel, afterIntel, held.goal);
        // PR16: re-derive the reference gaps against the after-state — the
        // CACHED analysis is reused (never re-decoded, §60) and gap
        // REDUCTION is judged as evidence. The goal gate stays the
        // authority: reference lines inform the retry, they never gate it.
        if (held.section.reference && held.referenceAnalysis && sectionVer.target.afterSectionId) {
          const afterTargetId = sectionVer.target.afterSectionId;
          const refIntelAfter = buildReferenceIntelligence(
            held.referenceAnalysis,
            afterIntel.features.sections,
            {
              targetSectionId: afterTargetId,
              ...(held.referencePinnedSectionId
                ? { referenceSectionId: held.referencePinnedSectionId }
                : {}),
            },
          );
          const afterRefCtx = buildReferencePlanningContext(
            { ...held.section.target, sectionId: afterTargetId },
            afterIntel.features.sections,
            refIntelAfter,
          );
          if (afterRefCtx) {
            referenceLines = presentReferenceVerification(
              verifyReferenceProgress(held.section.reference, afterRefCtx),
            );
          }
        }
      } catch (err) {
        debugLog(context, `SECTION verify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The loop's exit decision is one pure function (agent/loop.ts) — pass,
    // retry once, or stop. A retry with no mutation budget left is a stop:
    // it could only re-analyze and apologize.
    const left = mutationsLeft(executedToolsThisTurn, READ_ONLY_TOOLS);
    const action = gateAction(ev.met, held.retries, left);
    if (action === "pass") {
      pendingGoal = null;
      pendingPlan = null;
      debugLog(
        context,
        `GOAL MET: ${held.goal.objective}` +
          (plan ? ` · plan ${plan.executedCount}/${plan.total} steps` : "") +
          (sectionVer ? ` · section ${sectionVer.status}` : ""),
      );
      return null;
    }
    debugLog(
      context,
      `GOAL UNMET (${held.retries + 1}/${AGENT_MAX_RETRIES + 1}): ${[...ev.constraintIssues, ...ev.criteriaIssues].join("；")}` +
        (plan
          ? ` · plan: ${plan.unexecuted.length} steps unexecuted, ${plan.unobserved.length} effects unobserved`
          : "") +
        (action === "stop" && left <= 0 && held.retries < AGENT_MAX_RETRIES
          ? ` · mutation budget exhausted (${AGENT_MAX_STEPS}) — no retry`
          : ""),
    );
    if (action === "stop") {
      pendingGoal = null;
      pendingPlan = null;
      return {
        appendNote: goalUnmetNote(ev, language, plan ?? undefined, sectionVer, held.section?.target.name, referenceLines),
      };
    }
    held.retries++;
    // The single retry IS the replan: the old route already missed, so clear
    // it — the model re-declares a focused plan from the diagnosis (or fixes
    // directly). The report was computed above, before the clear. The section
    // verdict rides along so the retry sees which target-section metric
    // missed and by how much — the target itself is NOT re-resolved (target
    // stability across retry).
    const replanned = pendingPlan !== null;
    pendingPlan = null;
    return {
      inject: goalRetryMessage(
        held.goal,
        ev,
        held.retries,
        language,
        plan ?? undefined,
        replanned,
        sectionVer,
        held.section?.target.name,
        referenceLines,
      ),
    };
  } catch (err) {
    pendingGoal = null;
    pendingPlan = null;
    debugLog(context, `GOAL gate skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function callTool(
  context: Ctx,
  actions: { tool: string; input: unknown; result: unknown }[],
  name: string,
  input: Record<string, unknown>,
  yolo: boolean,
): Promise<string> {
  // Agent-loop step budget (agent/loop.ts): once AGENT_MAX_STEPS mutations
  // actually executed this turn, further mutating calls are refused BEFORE
  // running — and before the user is asked to confirm. The refusal never
  // enters executedToolsThisTurn (it didn't execute), so the budget can't be
  // talked past; the model must wrap up and let the user say "continue".
  if (
    !READ_ONLY_TOOLS.has(name) &&
    countMutations(executedToolsThisTurn, READ_ONLY_TOOLS) >= AGENT_MAX_STEPS
  ) {
    const refused = stepBudgetError();
    actions.push({ tool: name, input, result: refused });
    debugLog(context, `TOOL ${name} REFUSED: mutation budget ${AGENT_MAX_STEPS} exhausted`);
    return JSON.stringify(refused);
  }
  if (!READ_ONLY_TOOLS.has(name) && (!yolo || COSTLY_TOOLS.has(name))) {
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
    // Plan-layer step matching counts every call that actually ran — a call
    // whose verify later fails still executed ("missed target" ≠ "never
    // happened"); the step's effect check carries that diagnosis instead.
    if (!PLAN_META_TOOLS.has(name)) executedToolsThisTurn.push(name);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  result = await verifyToolResult(context, name, input, result);
  // Count executed mutations so a set_goal declared mid-turn can flag that
  // its baseline is already post-change (handleSetGoal's late warning).
  if (
    !READ_ONLY_TOOLS.has(name) &&
    !(result !== null && typeof result === "object" && "error" in result)
  ) {
    mutationsThisTurn++;
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
  // A new user turn: any goal from the previous turn has already been judged
  // (or abandoned) — never let a stale goal gate an unrelated request.
  pendingGoal = null;
  pendingPlan = null;
  mutationsThisTurn = 0;
  executedToolsThisTurn = [];
  const cfg = resolveConfig(req);
  // Custom endpoints may legitimately need no key (Ollama & co.) — they get
  // their own validation (baseUrl + model) inside chatCustom instead.
  if (cfg.provider === "custom") return chatCustom(context, cfg, req);
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
  const chatTools = activeTools();

  // Bounded retries when max_tokens truncates a text-only answer (see below).
  let continuations = 0;

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
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
      tools: chatTools,
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
            `messages=${messages.length} tools=${chatTools.length} · 响应: ${JSON.stringify(data).slice(0, 500)}`,
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
    const gate = await goalGate(context, req.language);
    if (gate && "inject" in gate) {
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: gate.inject });
      continue;
    }
    return finishChat(context, actions, gate ? reply + gate.appendNote : reply);
  }
  throw new Error(`工具调用轮次超过 ${AGENT_MAX_ROUNDS}，已中止 / Too many tool rounds, aborted`);
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
  const tools = activeTools().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
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
      const gate = await goalGate(context, req.language);
      if (gate && "inject" in gate) {
        input.push(...output);
        input.push({ role: "user", content: [{ type: "input_text", text: gate.inject }] });
        continue;
      }
      return finishChat(context, actions, gate ? reply + gate.appendNote : reply);
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
  throw new Error(`工具调用轮次超过 ${AGENT_MAX_ROUNDS}，已中止 / Too many tool rounds, aborted`);
}

// ---------- OpenAI-compatible chat/completions (custom endpoint) ----------

interface ChatCompletionsData {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  error?: { message?: string };
}

/**
 * Generic OpenAI-compatible endpoint. Speaks plain /chat/completions (the
 * flavor every third-party relay, OpenRouter and local server implements —
 * unlike /responses, which most of them lack) with no instructions field and
 * no effort mapping, so Grok- or DeepSeek-style backends accept the request
 * verbatim. Same 12-round tool loop as chatOpenAI.
 */
async function chatCustom(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error(
      CUSTOM_INCOMPLETE_HINT[req.language ?? ""] ?? CUSTOM_INCOMPLETE_HINT.en);
  }
  const messages: unknown[] = [
    { role: "system", content: systemPromptFor(req.language) },
    ...historyWithTools(currentSession(), {
      userText: (text) => ({ role: "user", content: text }),
      assistantText: (text) => ({ role: "assistant", content: text }),
      toolRound: (acts, p) =>
        acts.flatMap((a, i) => [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: p + i,
                type: "function",
                function: { name: a.tool, arguments: JSON.stringify(a.input ?? {}) },
              },
            ],
          },
          { role: "tool", tool_call_id: p + i, content: truncateResult(JSON.stringify(a.result)) },
        ]),
    }),
  ];
  const actions: { tool: string; input: unknown; result: unknown }[] = [];
  attachImages(messages, req, (last, images) => {
    last.content = [
      { type: "text", text: typeof last.content === "string" ? last.content : "" },
      ...images.map((im) => ({
        type: "image_url",
        image_url: { url: `data:${im.mime};base64,${im.data}` },
      })),
    ];
  });
  const tools = activeTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    if (stopRequested) return finishChat(context, actions, stopNote(req.language));
    const requestBody = JSON.stringify({ model: cfg.model, messages, tools });
    let data: ChatCompletionsData;
    let status: number;
    try {
      const res = await rawPost(new URL(`${cfg.baseUrl}/chat/completions`), {
        headers: {
          "content-type": "application/json",
          ...(cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : {}),
        },
        body: requestBody,
        proxy: detectProxy(),
        signal: abortCtl?.signal,
      });
      status = res.status;
      data = JSON.parse(await readAll(res.stream)) as ChatCompletionsData;
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw err;
    }
    if (status < 200 || status >= 300) {
      console.error(
        `[ai-assistant] custom API ${status} · 请求 ${requestBody.length} 字符 · 响应: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw new Error(data.error?.message || `自定义端点错误 (${status})`);
    }
    const msg = data.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).filter((c) => c.function?.name);
    debugLog(context,
      `ROUND ${round}: content=${(msg.content ?? "").length} chars, tool_calls=${calls.length}`);
    if (!calls.length) {
      const reply =
        (typeof msg.content === "string" ? msg.content : "").trim() || "（无文本回复）";
      const gate = await goalGate(context, req.language);
      if (gate && "inject" in gate) {
        messages.push({ role: "assistant", content: msg.content ?? "" });
        messages.push({ role: "user", content: gate.inject });
        continue;
      }
      return finishChat(context, actions, gate ? reply + gate.appendNote : reply);
    }
    // Echo the model's message (with its tool_calls verbatim), then append results.
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });
    for (const call of calls) {
      if (stopRequested) return finishChat(context, actions, stopNote(req.language));
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = JSON.parse(call.function!.arguments || "{}") as Record<string, unknown>;
      } catch {
        // Malformed arguments — run with empty input, the tool error explains.
      }
      const resultJson = await callTool(context, actions, call.function!.name!, toolInput, req.yolo !== false);
      messages.push({ role: "tool", tool_call_id: call.id ?? "", content: resultJson });
    }
  }
  throw new Error(`工具调用轮次超过 ${AGENT_MAX_ROUNDS}，已中止 / Too many tool rounds, aborted`);
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
      functionDeclarations: activeTools().map((tool) => ({
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

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
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
      const gate = await goalGate(context, req.language);
      if (gate && "inject" in gate) {
        contents.push({ role: "model", parts });
        contents.push({ role: "user", parts: [{ text: gate.inject }] });
        continue;
      }
      return finishChat(context, actions, gate ? reply + gate.appendNote : reply);
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
  throw new Error(`工具调用轮次超过 ${AGENT_MAX_ROUNDS}，已中止 / Too many tool rounds, aborted`);
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
        providerParam === "codex" || providerParam === "gemini" || providerParam === "custom"
          ? providerParam
          : "claude";
      const cfg = resolveConfig({ provider });
      const manual = manualConfigs[provider];
      const source =
        manual && (manual.apiKey || manual.authToken || manual.refreshToken ||
                   (provider === "custom" && manual.baseUrl))
          ? "manual"
          : loadLocalConfig(provider)
            ? "cli"
            : "none";
      send(200, JSON.stringify({
        ok: true,
        provider: cfg.provider,
        // Custom endpoints may run keyless — "configured" means baseUrl + model.
        hasAuth: provider === "custom"
          ? Boolean(cfg.baseUrl && cfg.model)
          : Boolean(cfg.authToken),
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
        providerParam === "codex" || providerParam === "gemini" || providerParam === "custom"
          ? providerParam
          : "claude";
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
          parsed.provider === "codex" || parsed.provider === "gemini" ||
          parsed.provider === "custom"
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
    if (req.method === "GET" && req.url === "/api/last-provider") {
      send(200, JSON.stringify({ provider: lastProvider }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/last-provider") {
      readBody((parsed) => {
        const p = parsed.provider;
        if (p === "claude" || p === "codex" || p === "gemini" || p === "custom") {
          if (p !== lastProvider) {
            lastProvider = p;
            saveManualConfigs();
          }
          send(200, JSON.stringify({ ok: true, provider: lastProvider }));
        } else {
          send(400, JSON.stringify({ error: "unknown provider" }));
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/audio-config") {
      send(200, JSON.stringify(audioSettings));
      return;
    }
    if (req.method === "POST" && req.url === "/api/audio-config") {
      readBody((parsed) => {
        // Three merge-style variants (the UI sends whichever changed):
        //   { selected }                    — last picked audio provider
        //   { provider, config }            — that provider's key/baseUrl ("" deletes)
        //   { custom }                      — custom-template fields ("" deletes)
        let changed = false;
        if (AUDIO_PROVIDERS_ALL.includes(parsed.selected as AudioProvider)) {
          if (audioSettings.selected !== parsed.selected) {
            audioSettings.selected = parsed.selected as AudioProvider;
            changed = true;
          }
        }
        if (AUDIO_PROVIDERS_ALL.includes(parsed.provider as AudioProvider) &&
            parsed.config && typeof parsed.config === "object") {
          const p = parsed.provider as AudioProvider;
          const cur = { ...(audioSettings.fields[p] ?? {}) } as Record<string, unknown>;
          for (const key of ["apiKey", "baseUrl"] as const) {
            const fields = parsed.config as Record<string, unknown>;
            const v = fields[key];
            if (typeof v === "string" && v.trim()) cur[key] = v.trim();
            else if (key in fields) delete cur[key];
          }
          if (Object.keys(cur).length) audioSettings.fields[p] = cur;
          else delete audioSettings.fields[p];
          changed = true;
        }
        if (parsed.custom && typeof parsed.custom === "object") {
          const fields = parsed.custom as Record<string, unknown>;
          for (const key of ["authHeader", "bodyTemplate", "responseType", "audioPath",
            "format", "pollUrl", "pollTaskId", "pollStatusPath", "pollDoneValue",
            "pollAudioPath"] as const) {
            const v = fields[key];
            if (typeof v === "string" && v.trim())
              (audioSettings.custom as Record<string, unknown>)[key] = v.trim();
            else if (key in fields)
              delete (audioSettings.custom as Record<string, unknown>)[key];
          }
          changed = true;
        }
        if (changed) saveManualConfigs();
        send(200, JSON.stringify({ ok: true, audio: audioSettings }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/web-config") {
      send(200, JSON.stringify(webSettings));
      return;
    }
    if (req.method === "POST" && req.url === "/api/web-config") {
      readBody((parsed) => {
        webSettings.enabled = parsed.enabled === true;
        saveManualConfigs();
        send(200, JSON.stringify({ ok: true, web: webSettings }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/memory") {
      send(200, JSON.stringify(artistMemory));
      return;
    }
    if (req.method === "POST" && req.url === "/api/memory") {
      readBody((parsed) => {
        // Settings-UI write: FULL replace of the editable fields (unlike the
        // update_memory tool's partial merge), with the same sanitizers.
        const p: ArtistMemory = {};
        if (typeof parsed.name === "string" && parsed.name.trim()) p.name = parsed.name.trim();
        p.genres = toStrArr(parsed.genres);
        p.keys = toStrArr(parsed.keys);
        p.sound = toStrArr(parsed.sound);
        p.artists = toStrArr(parsed.artists);
        p.bpmMin = toBpm(parsed.bpmMin);
        p.bpmMax = toBpm(parsed.bpmMax);
        if (p.bpmMin && p.bpmMax && p.bpmMin > p.bpmMax) {
          [p.bpmMin, p.bpmMax] = [p.bpmMax, p.bpmMin];
        }
        if (typeof parsed.notes === "string" && parsed.notes.trim()) p.notes = parsed.notes.trim();
        artistMemory = p;
        saveArtistMemory();
        send(200, JSON.stringify({ ok: true, memory: artistMemory }));
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
        pending: pendingConfirm
          ? { tool: pendingConfirm.tool, input: pendingConfirm.input, costly: pendingConfirm.costly }
          : null,
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
        // Remember the provider actually chatted with, so a reopened window
        // (whose localStorage may be empty) defaults to it.
        const chatProvider: Provider =
          parsed.provider === "codex" || parsed.provider === "gemini" ||
          parsed.provider === "custom"
            ? parsed.provider
            : "claude";
        if (chatProvider !== lastProvider) {
          lastProvider = chatProvider;
          saveManualConfigs();
        }
        busy = true;
        lastError = null;
        stopRequested = false;
        abortCtl = new AbortController();
        activeAudioConfig = resolveAudioConfig(
          mergeAudioRequest(parsed.audio as AudioRequestConfig | undefined));
        activeLanguage = typeof parsed.language === "string" ? parsed.language : undefined;
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
            activeLanguage = undefined;
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
    loadArtistMemory(context);
    tryListen(PREFERRED_PORT);
  });
}
