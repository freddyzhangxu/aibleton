// The Live extension sandbox does NOT expose Node's usual globals — URL and
// Buffer must be imported explicitly per module (a bare `new URL()` crashes
// the process with ReferenceError inside request handlers).
import { URL } from "node:url";
import { toolHooks, toolState, type Ctx } from "../../state.js";
import { AGENT_MAX_ROUNDS } from "../../agent/loop.js";
import { detectProxy, rawPost, readAll } from "../../http.js";
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

export async function chatGemini(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
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
    toolHooks.debugLog(
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

