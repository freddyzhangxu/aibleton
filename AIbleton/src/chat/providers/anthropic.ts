import { toolHooks, toolState, type Ctx } from "../../state.js";
import { AGENT_MAX_ROUNDS } from "../../agent/loop.js";
import { activeTools } from "../../tools/definitions.js";
import { stopNote, systemPromptFor, TRUNC_NOTE } from "../../prompts.js";
import {
  currentSession,
  finishChat,
  truncateResult,
} from "../session.js";
import { callTool, goalGate } from "../../agent/runtime.js";
import { attachImages, historyWithTools } from "../history.js";
import type { ChatRequest, ResolvedConfig } from "../config.js";

export async function chatAnthropic(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
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
    if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw err;
    }

    const content = data.content ?? [];
    toolHooks.debugLog(
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
        if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
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
        toolHooks.debugLog(context, `ROUND ${round}: max_tokens — auto-continue ${continuations}/2`);
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

