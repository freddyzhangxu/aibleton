import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
// The Live extension sandbox does NOT expose Node's usual globals — URL must
// be imported explicitly (a bare `new URL()` crashes the process with
// ReferenceError inside request handlers).
import { URL } from "node:url";
import { describeBinaryAttachment } from "./fileparsers.js";
import {
  resolveAudioConfig,
  type AudioProvider,
  type AudioRequestConfig,
  type CustomAudioTemplate,
} from "./audiogen.js";
import {
  AUDIO_EXT,
  listAudioFilesViaFind,
  mkdirOutsideSandbox,
  readHomeFile,
  sampleRoots,
  writeHomeFile,
} from "./paths.js";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import { toSampleEntry, type SampleEntry } from "./samplemeta.js";
import { loadLocalConfig, PROVIDER_NAMES, type LocalConfig, type Provider } from "./config/local.js";
import {
  chatStoreDir,
  createSession,
  currentSession,
  deleteSession,
  listSessions,
  loadStore,
  saveStore,
  storeFilePath,
  switchSession,
} from "./chat/session.js";
import { answerConfirmation, getPendingConfirm } from "./chat/gates.js";
import { resolveConfig, type Attachment, type ChatRequest } from "./chat/config.js";
import { resetTurnState } from "./agent/runtime.js";
import { chatAnthropic } from "./chat/providers/anthropic.js";
import { chatOpenAI, ensureCodexAuth } from "./chat/providers/openai.js";
import { chatCustom } from "./chat/providers/custom.js";
import { chatGemini } from "./chat/providers/gemini.js";
import { toolHooks, toolState, type ArtistMemory } from "./state.js";
import { toBpm, toStrArr } from "./tools/helpers.js";
import { NO_AUTH_HINT } from "./prompts.js";
import { loadSkills, matchSkills } from "./skills.js";

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
  const dir = chatStoreDir(context);
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
  const dir = chatStoreDir(context);
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
toolHooks.debugLog = debugLog;
toolHooks.getAudioAutoRefine = () => audioSettings.autoRefine === true;
toolHooks.getManualConfig = (provider) => manualConfigs[provider];
toolHooks.updateManualCodexToken = (accessToken, refreshToken) => {
  const manual = manualConfigs.codex;
  if (manual?.refreshToken) {
    manual.authToken = accessToken;
    if (refreshToken) manual.refreshToken = refreshToken;
    saveManualConfigs();
  }
};
toolHooks.saveArtistMemory = saveArtistMemory;
toolHooks.saveManualConfigs = saveManualConfigs;
toolHooks.invalidateSampleIndex = () => {
  sampleIndex = null;
};
toolHooks.buildSampleIndex = buildSampleIndex;


// ---------- Audio-generation providers (see audiogen.ts) ----------





// ---------- Claude API with tool-use loop ----------

/**
 * A file the user attached in the UI: text content (text), base64 image
 * (data), or a binary music file (kind + data) that gets parsed into a text
 * summary before reaching the model.
 */



// ---------- Chat sessions (server-side, persisted) ----------


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




async function chat(context: Ctx, req: ChatRequest) {
  // A new user turn: any goal from the previous turn has already been judged
  // (or abandoned) — never let a stale goal gate an unrelated request.
  resetTurnState();
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
    if (req.method === "GET" && req.url === "/api/skills") {
      // Slash-picker listing: metadata only, bodies load server-side on match.
      send(
        200,
        JSON.stringify(
          loadSkills().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })),
        ),
      );
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
        sessions: listSessions().map((s) => ({
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
        const target = switchSession(String(parsed.id));
        if (!target) {
          send(404, JSON.stringify({ error: "会话不存在" }));
          return;
        }
        saveStore(context);
        send(200, JSON.stringify({ messages: target.messages }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/delete") {
      readBody((parsed) => {
        deleteSession(String(parsed.id));
        saveStore(context);
        send(200, JSON.stringify({ messages: currentSession().messages }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/status") {
      send(200, JSON.stringify({
        busy,
        error: lastError,
        pending: getPendingConfirm(),
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/confirm") {
      readBody((parsed) => {
        const answered = answerConfirmation(parsed.allow === true);
        send(answered ? 200 : 409, JSON.stringify({ ok: answered }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/stop") {
      // UI stop button: flag the running task, abort its in-flight request,
      // and release any tool call waiting on Allow/Deny so it can unwind.
      if (busy) {
        toolState.stopRequested = true;
        toolState.abortCtl?.abort();
        answerConfirmation(false);
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
        toolState.stopRequested = false;
        toolState.abortCtl = new AbortController();
        toolState.activeAudioConfig = resolveAudioConfig(
          mergeAudioRequest(parsed.audio as AudioRequestConfig | undefined));
        toolState.activeLanguage = typeof parsed.language === "string" ? parsed.language : undefined;
        // Respond immediately: the task runs in the background on the extension
        // side, so closing the dialog (which kills this connection) does NOT
        // stop it. Clients poll /api/status and then read /api/history.
        send(202, JSON.stringify({ ok: true }));
        debugLog(context, `TASK start: "${text.slice(0, 60)}"`);
        const matched = matchSkills(text);
        if (matched.length) {
          debugLog(context, `SKILLS matched: ${matched.map((s) => s.name).join(", ")}`);
        }
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
            answerConfirmation(false);
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
