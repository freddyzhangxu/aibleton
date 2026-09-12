// The Live extension sandbox does NOT expose Node's usual globals — URL and
// Buffer must be imported explicitly per module (a bare `new URL()` crashes
// the process with ReferenceError inside request handlers).
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import * as os from "node:os";
import * as path from "node:path";
import { toolHooks, toolState, type Ctx } from "../../state.js";
import { AGENT_MAX_ROUNDS } from "../../agent/loop.js";
import { readHomeFile, writeHomeFile } from "../../paths.js";
import { detectProxy, rawPost, readAll } from "../../http.js";
import { updateCodexTokenCache } from "../../config/local.js";
import { activeTools } from "../../tools/definitions.js";
import { stopNote, systemPromptFor } from "../../prompts.js";
import {
  currentSession,
  finishChat,
  truncateResult,
} from "../session.js";
import { callTool, goalGate } from "../../agent/runtime.js";
import { attachImages, historyWithTools } from "../history.js";
import type { ChatRequest, ResolvedConfig } from "../config.js";

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
  toolHooks.updateManualCodexToken(data.access_token, data.refresh_token);
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
export async function ensureCodexAuth(cfg: ResolvedConfig): Promise<void> {
  if (!cfg.chatgpt) return;
  const exp = cfg.authToken ? jwtExp(cfg.authToken) : null;
  if (exp && exp - Date.now() / 1000 > 120) return; // still valid
  if (exp) await refreshCodexToken(cfg); // expired — refresh before the call
  // No readable exp (opaque token): proceed; a 401 triggers the refresh retry.
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
async function readResponsesStream(
  stream: AsyncIterable<Buffer>,
  log?: (line: string) => void,
): Promise<OpenAIResponseData> {
  const t0 = Date.now();
  let chunks = 0;
  let bytes = 0;
  const eventTypes: string[] = [];
  let buf = "";
  let rawNonSse = "";
  let finalResponse: OpenAIResponseData | null = null;
  let streamError: string | null = null;
  const items: OpenAIOutputItem[] = [];
  try {
    for await (const chunk of stream) {
      chunks++;
      bytes += chunk.length;
      buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) {
        // The backend answers quota/auth failures with a plain JSON error
        // body instead of an SSE stream — keep it so it can be surfaced.
        if (line) rawNonSse += line;
        continue;
      }
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
      if (evt.type) eventTypes.push(evt.type);
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
  } catch (err) {
    log?.(
      `SSE stream threw after ${chunks} chunks ${bytes}B in ${Date.now() - t0}ms: ` +
        `${err instanceof Error ? err.message : String(err)} — events=[${eventTypes.join(",")}]`,
    );
    throw err;
  }
  log?.(
    `SSE stream ended: ${chunks} chunks ${bytes}B in ${Date.now() - t0}ms, ` +
      `events=[${eventTypes.join(",")}], items=${items.length}, ` +
      `final=${finalResponse ? "yes" : "no"}, tail=${JSON.stringify(buf.slice(-300))}`,
  );
  if (finalResponse) {
    if (!finalResponse.output?.length && items.length) finalResponse.output = items;
    return finalResponse;
  }
  if (streamError) throw new Error(streamError);
  // A body without a trailing newline never entered the line loop — it is
  // still sitting in buf (the quota error body arrives exactly like this).
  const leftover = buf.trim();
  if (leftover && !leftover.startsWith("data:")) rawNonSse += leftover;
  // No SSE events at all but a JSON error body arrived (quota, auth, …) —
  // surface THAT message instead of the generic "stream interrupted".
  if (!eventTypes.length && rawNonSse) {
    try {
      const body = JSON.parse(rawNonSse) as { error?: { type?: string; message?: string } };
      if (body.error?.message) throw new Error(body.error.message);
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`OpenAI 返回了非 SSE 响应: ${rawNonSse.slice(0, 300)}`);
      }
      throw e;
    }
  }
  throw new Error("OpenAI 流式响应中断（未收到 completed 事件）");
}

export async function chatOpenAI(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
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
        ? await readResponsesStream(res.stream, (line) => toolHooks.debugLog(context, line))
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
    toolHooks.debugLog(context, `ROUND ${round}: output=${output.map((o) => o.type).join(",")}`);
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

