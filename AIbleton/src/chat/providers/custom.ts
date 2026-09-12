import { toolHooks, toolState, type Ctx } from "../../state.js";
import { AGENT_MAX_ROUNDS } from "../../agent/loop.js";
import { detectProxy, rawPost, readAll } from "../../http.js";
import { activeTools } from "../../tools/definitions.js";
import { CUSTOM_INCOMPLETE_HINT, stopNote, systemPromptFor } from "../../prompts.js";
import {
  currentSession,
  finishChat,
  truncateResult,
} from "../session.js";
import { attachImages, callTool, goalGate, historyWithTools } from "../toolgate.js";
import type { ChatRequest, ResolvedConfig } from "../config.js";

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
export async function chatCustom(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
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
    toolHooks.debugLog(context,
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

