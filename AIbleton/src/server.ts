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
import { AGENT_MAX_ROUNDS } from "./agent/loop.js";
import { toSampleEntry, type SampleEntry } from "./samplemeta.js";
import { loadLocalConfig, PROVIDER_NAMES, updateCodexTokenCache, type LocalConfig, type Provider } from "./config/local.js";
import {
  chatStoreDir,
  createSession,
  currentSession,
  deleteSession,
  finishChat,
  listSessions,
  loadStore,
  saveStore,
  storeFilePath,
  switchSession,
  truncateResult,
} from "./chat/session.js";
import { answerConfirmation, getPendingConfirm } from "./chat/gates.js";
import { resolveConfig, type Attachment, type ChatRequest, type ResolvedConfig } from "./chat/config.js";
import { attachImages, goalGate, callTool, historyWithTools, resetTurnState } from "./chat/toolgate.js";
import { chatAnthropic } from "./chat/providers/anthropic.js";
import { activeTools } from "./tools/definitions.js";
import { toolHooks, toolState, type ArtistMemory } from "./state.js";
import { toBpm, toStrArr } from "./tools/helpers.js";
import {
  CUSTOM_INCOMPLETE_HINT,
  NO_AUTH_HINT,
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
    updateCodexTokenCache(data.access_token, data.refresh_token);
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
    if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
    if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
    if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
