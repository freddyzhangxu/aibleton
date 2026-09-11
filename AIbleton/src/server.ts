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
import {
  AUDIO_PROVIDER_NAMES,
  resolveAudioConfig,
  type AudioProvider,
  type AudioRequestConfig,
  type CustomAudioTemplate,
} from "./audiogen.js";
import {
  AUDIO_EXT,
  listAudioFilesViaFind,
  mkdirOutsideSandbox,
  readHomeBinary,
  readHomeFile,
  sampleRoots,
  storeFallbackPath,
  writeHomeFile,
} from "./paths.js";
import {
  diffGenerations,
  latestGeneration,
  loadGenLog,
  REFINE_DISCIPLINE,
  suggestForGenGap,
  type GenGap,
} from "./genlog/index.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import { analyzeMusicState } from "./analysis/index.js";
import { pcName } from "./analysis/interpret.js";
import { enrichMusicStateWithAudio } from "./audiofiles.js";
import { buildMusicState } from "./musicstate/builder.js";
import { postconditionsFor } from "./verify/rules.js";
import { runVerification } from "./verify/verifier.js";
import type { ProbeSong } from "./verify/types.js";
import { goalNeedsAudio, goalNeedsGenlog, normalizeGoal, type GoalEvaluation, type MusicGoal } from "./goal/types.js";
import { buildGoalView, type GoalView } from "./goal/view.js";
import { evaluateGoal } from "./goal/evaluate.js";
import { normalizePlan, planNeedsAudio, type MusicPlan } from "./plan/types.js";
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
  AGENT_MAX_REFINEMENTS,
  AGENT_MAX_RETRIES,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_STEPS,
  countMutations,
  gateAction,
  mutationsLeft,
  refineHasNewArtifact,
  stepBudgetError,
} from "./agent/loop.js";
import { toSampleEntry, type SampleEntry } from "./samplemeta.js";
import { activeTools, TOOLS } from "./tools/definitions.js";
import { toolHooks, toolState, type ArtistMemory } from "./state.js";
import { runTool } from "./tools/dispatcher.js";
import { buildSongSnapshot, toBpm, toStrArr } from "./tools/helpers.js";
import {
  CUSTOM_INCOMPLETE_HINT,
  NO_AUTH_HINT,
  TRUNC_NOTE,
  stopNote,
  systemPromptFor,
} from "./prompts.js";

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
  /** PR19: when ON, generate_audio calls inside an active refine loop skip
   * the per-call confirmation (the user pre-authorized bounded iteration).
   * Default OFF — every generation is confirmed one by one. */
  autoRefine?: boolean;
};
let audioSettings: PersistedAudio = { fields: {}, custom: {} };

let memoryPath: string | null = null;


function loadArtistMemory(context: Ctx): void {
  // Same directory resolution as loadManualConfigs (storage dir or fallback).
  const dir = storeFileOverride
    ? path.dirname(storeFileOverride)
    : context.environment.storageDirectory || path.dirname(storeFallbackPath());
  memoryPath = path.join(dir, "memory.json");
  toolState.artistMemory = {};
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
    toolState.artistMemory = p;
    // Object.keys would also count keys assigned undefined — count real values.
    const n = Object.values(p).filter((v) => v !== undefined).length;
    if (n) console.log(`[ai-assistant] Artist memory 已加载（${n} 个字段）: ${p.name ?? p.genres?.join("/") ?? "…"}`);
  } catch {
    toolState.artistMemory = {};
  }
}

function saveArtistMemory(): void {
  if (!memoryPath) return;
  try {
    mkdirOutsideSandbox(path.dirname(memoryPath));
    writeHomeFile(memoryPath, JSON.stringify(toolState.artistMemory, null, 2));
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
        ...(a.autoRefine === true ? { autoRefine: true } : {}),
      };
    }
    toolState.webSettings.enabled = data.web?.enabled === true;
    const mv = data.move;
    if (mv && typeof mv === "object") {
      toolState.moveSettings = {
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
      JSON.stringify({ ...manualConfigs, lastProvider, audio: audioSettings, web: toolState.webSettings, move: toolState.moveSettings }, null, 2));
  } catch {
    // In-memory copy still works for this run.
  }
}

type Ctx = ExtensionContext<"1.0.0">;

// Wire the late-bound hooks tools/* call back into server-owned state.
// Function declarations hoist, so this top-level assignment sees them all.
toolHooks.saveArtistMemory = saveArtistMemory;
toolHooks.saveManualConfigs = saveManualConfigs;
toolHooks.invalidateSampleIndex = () => {
  sampleIndex = null;
};
toolHooks.buildSampleIndex = buildSampleIndex;
toolHooks.handleSetGoal = handleSetGoal;
toolHooks.handleSetPlan = handleSetPlan;

/** Stamp the latest genlog record onto a GoalView for the gen_* judges
 * (goalNeedsGenlog gates the call). Registry reads stay out of
 * buildGoalView itself, which measures only the Set. */
function attachLatestGeneration(view: GoalView): void {
  const rec = latestGeneration();
  if (!rec) return;
  view.latestGeneration = {
    id: rec.id,
    provider: rec.provider,
    ...(rec.features ? { features: rec.features } : {}),
    ...(rec.featuresError ? { featuresError: rec.featuresError } : {}),
  };
}

// ---------- Audio-generation providers (see audiogen.ts) ----------





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
    provider: toolState.activeAudioConfig ? AUDIO_PROVIDER_NAMES[toolState.activeAudioConfig.provider] : "?",
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
  /** Generation refinements spent this turn (PR19) — an independent counter
   * from retries: a refine regenerates the artifact, it never replans. */
  refinements: number;
  /** Generation id the last refine was fired against — a refine only burns
   * budget when a NEWER artifact shows up at the next gate (a text-only
   * answer to a refine injection must not spend the counter). */
  refineSeenGenId?: string;
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
 * these numbers when picking thresholds. With Scale Mode on, Live's declared
 * scale is stronger evidence than the detected key and rides as liveScale;
 * offKeyPct gives in_key/off_key_lte goals their measured starting point. */
function summarizeView(v: GoalView): Record<string, unknown> {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    tempo: v.tempo,
    key: v.keyBest ?? null,
    liveScale: v.liveScale.mode
      ? { root: pcName(v.liveScale.root), name: v.liveScale.name, intervals: v.liveScale.intervals }
      : null,
    offKeyPct: v.offKeyRatio !== undefined ? r2(v.offKeyRatio * 100) : null,
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
    const baseline = buildGoalView(state);
    // gen_* criteria judge the registry, not the Set: the latest record at
    // declaration time is the "previous iteration" gen_improved_vs_prev
    // compares against. Anchored here so a re-declared goal keeps it.
    if (goalNeedsGenlog(norm.goal)) attachLatestGeneration(baseline);
    held = {
      baseline,
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
    refinements: prevGoal?.refinements ?? 0,
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

/** Compact diff of the last two registry records — "what the previous
 * refinement actually changed", so the next prompt edit is attributable. */
function lastIterationDiffLines(): string[] {
  const records = loadGenLog();
  if (records.length < 2) return [];
  const diff = diffGenerations(records[records.length - 2], records[records.length - 1]);
  const entries = Object.entries(diff.metrics)
    .filter(([, e]) => e !== undefined && Math.abs(e.delta) > 1e-9)
    .sort((a, b) => Math.abs(b[1]!.delta) - Math.abs(a[1]!.delta))
    .slice(0, 6);
  if (!entries.length) return [];
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  return [
    `上一轮迭代变化（${diff.from} → ${diff.to}）：` +
      entries.map(([m, e]) => `${m} ${fmt(e!.before)}→${fmt(e!.after)}（Δ ${e!.delta > 0 ? "+" : ""}${fmt(e!.delta)}）`).join("，"),
  ];
}

/** PR19 refine injection: the failed gen_* checks, deterministic parameter
 * hints, and the last iteration's diff. The plan is intentionally NOT
 * cleared — the route was fine, the artifact wasn't. */
function goalRefineMessage(
  goal: MusicGoal,
  ev: GoalEvaluation,
  genGaps: GenGap[],
  refinements: number,
): string {
  const lines: string[] = [
    `【生成迭代 / Generation refine】第 ${refinements}/${AGENT_MAX_REFINEMENTS} 次迭代 — 目标「${goal.objective}」的生成产物尚未达标：`,
  ];
  const genIssues = [...ev.constraintIssues, ...ev.criteriaIssues].filter((i) => i.startsWith("gen."));
  if (genIssues.length) lines.push(`未达成：${genIssues.join("；")}`);
  if (refinements > 1) lines.push(...lastIterationDiffLines());
  lines.push(`调整建议：${genGaps.map((g) => suggestForGenGap(g)).join("；")}`);
  lines.push(REFINE_DISCIPLINE);
  lines.push(
    `请用调整后的 prompt 再次调用 generate_audio（建议带 importTo 直接上轨）。剩余迭代预算：${AGENT_MAX_REFINEMENTS - refinements} 次。` +
      (audioSettings.autoRefine === true
        ? ""
        : `（autoRefine 未开启，每次生成仍需你确认 — 可在 设置 → 音频生成 里打开自动迭代）`),
  );
  return lines.join("\n");
}

/** PR20 finding: the relay can HALLUCINATE a failure narrative (it imitated
 * the unmet note's exact format with fabricated numbers). On a real pass the
 * gate previously appended nothing, leaving the model's text as the only
 * verdict the user saw. The measured pass now always lands as a system line
 * with the actual numbers, so a fabricated failure is visibly contradicted. */
function goalMetNote(ev: GoalEvaluation, language?: string): string {
  const zh = (language ?? "").startsWith("zh") || !language;
  const head = zh ? "\n\n✅ 目标校验通过（系统实测）：" : "\n\n✅ Goal check passed (server-measured): ";
  const passed = ev.checks
    .filter((c) => c.passed)
    .map((c) => `${c.id}${c.actual ? ` = ${c.actual}` : ""}`)
    .join("；");
  const tail = zh ? "。以系统实测为准。" : ". Trust this over any text above.";
  return `${head}${passed || "—"}${tail}`;
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
    if (goalNeedsGenlog(held.goal)) attachLatestGeneration(after);
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
    // refine, retry once, or stop. A retry/refine with no mutation budget
    // left is a stop: it could only re-analyze and apologize.
    const left = mutationsLeft(executedToolsThisTurn, READ_ONLY_TOOLS);
    // PR19 refine eligibility: a gen_* criterion failed AND there is an
    // analyzable artifact to improve on. ev.checks aligns index-for-index
    // with constraints-then-criteria (evaluateGoal's construction), so the
    // gap direction comes straight from the failed criterion.
    const genGaps: GenGap[] = [];
    [...held.goal.constraints, ...held.goal.successCriteria].forEach((c, i) => {
      if (ev.checks[i]?.passed !== false) return;
      if (c.kind === "gen_metric_gte") {
        genGaps.push({ metric: c.metric, ...(c.band ? { band: c.band } : {}), direction: "up" });
      } else if (c.kind === "gen_improved_vs_prev") {
        genGaps.push({ metric: c.metric, ...(c.band ? { band: c.band } : {}), direction: c.direction });
      }
    });
    const refine = {
      available:
        genGaps.length > 0 &&
        after.latestGeneration?.features !== undefined &&
        refineHasNewArtifact(after.latestGeneration?.id, held.refineSeenGenId),
      used: held.refinements,
    };
    const action = gateAction(ev.met, held.retries, left, refine);
    if (action === "pass") {
      pendingGoal = null;
      pendingPlan = null;
      debugLog(
        context,
        `GOAL MET: ${held.goal.objective}` +
          (plan ? ` · plan ${plan.executedCount}/${plan.total} steps` : "") +
          (sectionVer ? ` · section ${sectionVer.status}` : ""),
      );
      return { appendNote: goalMetNote(ev, language) };
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
    if (action === "refine") {
      // A refine is NOT a retry: the plan executed, the artifact missed — so
      // the plan and the retry counter stay untouched, and the injection is
      // the iteration diff + deterministic parameter hints, not a replan
      // diagnosis.
      held.refinements++;
      held.refineSeenGenId = after.latestGeneration?.id;
      debugLog(
        context,
        `GOAL REFINE (${held.refinements}/${AGENT_MAX_REFINEMENTS}): ${genGaps.map((g) => g.metric).join(", ")}`,
      );
      return { inject: goalRefineMessage(held.goal, ev, genGaps, held.refinements) };
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
  // Costly tools confirm even under YOLO — EXCEPT generate_audio inside an
  // active refine loop when the user turned autoRefine on: the refinement
  // budget (AGENT_MAX_REFINEMENTS) is the pre-authorized spend limit, and a
  // per-call dialog would defeat unattended iteration. Outside a refine —
  // or with autoRefine off — every generation still asks.
  const refinePreAuthorized =
    COSTLY_TOOLS.has(name) &&
    audioSettings.autoRefine === true &&
    (pendingGoal?.refinements ?? 0) > 0;
  const needsConfirm =
    !READ_ONLY_TOOLS.has(name) && !refinePreAuthorized && (!yolo || COSTLY_TOOLS.has(name));
  if (needsConfirm) {
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
        signal: toolState.abortCtl?.signal ?? null,
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
        signal: toolState.abortCtl?.signal,
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
        signal: toolState.abortCtl?.signal,
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
          signal: toolState.abortCtl?.signal,
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
        // Four merge-style variants (the UI sends whichever changed):
        //   { selected }                    — last picked audio provider
        //   { provider, config }            — that provider's key/baseUrl ("" deletes)
        //   { custom }                      — custom-template fields ("" deletes)
        //   { autoRefine }                  — unattended refine-loop generation
        let changed = false;
        if (typeof parsed.autoRefine === "boolean") {
          if (parsed.autoRefine) audioSettings.autoRefine = true;
          else delete audioSettings.autoRefine;
          changed = true;
        }
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
      send(200, JSON.stringify(toolState.webSettings));
      return;
    }
    if (req.method === "POST" && req.url === "/api/web-config") {
      readBody((parsed) => {
        toolState.webSettings.enabled = parsed.enabled === true;
        saveManualConfigs();
        send(200, JSON.stringify({ ok: true, web: toolState.webSettings }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/memory") {
      send(200, JSON.stringify(toolState.artistMemory));
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
        toolState.artistMemory = p;
        saveArtistMemory();
        send(200, JSON.stringify({ ok: true, memory: toolState.artistMemory }));
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
        toolState.abortCtl?.abort();
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
        toolState.abortCtl = new AbortController();
        toolState.activeAudioConfig = resolveAudioConfig(
          mergeAudioRequest(parsed.audio as AudioRequestConfig | undefined));
        toolState.activeLanguage = typeof parsed.language === "string" ? parsed.language : undefined;
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
            toolState.abortCtl = null;
            toolState.activeLanguage = undefined;
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
