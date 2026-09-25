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
import { errMessage, friendlyApiError, settingsPath } from "../../errors.js";
import { attachImages, historyWithTools } from "../history.js";
import type { ChatRequest, ResolvedConfig } from "../config.js";
import { commonText } from "../../i18n/common.js";
import { requestAnthropicRound, type AnthropicRoundData } from "./anthropic-transport.js";
import {
  languageCorrectionPrompt,
  MAX_REPLY_LANGUAGE_CORRECTIONS,
  replyNeedsLanguageCorrection,
} from "../../i18n/language.js";

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
  let languageCorrections = 0;
  let languageRewriteOnly = false;
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

  // Effort controls extended thinking only; keep the output allowance the
  // same across levels. max_tokens must exceed the largest thinking budget.
  const CLAUDE_MAX_TOKENS = 49152;
  const CLAUDE_EFFORT: Record<string, { budget: number }> = {
    low:    { budget: 1024 },
    medium: { budget: 4096 },
    high:   { budget: 8192 },
    xhigh:  { budget: 16384 },
    max:    { budget: 32768 },
  };
  const claudeEffort = CLAUDE_EFFORT[cfg.effort ?? ""];
  const thinking = claudeEffort
    ? { type: "enabled", budget_tokens: claudeEffort.budget }
    : undefined;
  const chatTools = activeTools();

  // Continue text-only answers until they finish or this turn reaches the
  // provider-round safety limit.
  let continuations = 0;
  // Visible text salvaged from truncated rounds — without this the user only
  // ever sees the LAST round's text and earlier partials are silently lost.
  let textCarry = "";
  // Set when a round burns its whole budget on thinking: drop the thinking
  // field for the rest of this task so the model acts instead of deliberating.
  let suppressThinking = false;

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
    const requestBody = {
      model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPromptFor(req.language, req.selectedSkillNames),
      ...(languageRewriteOnly ? {} : { tools: chatTools }),
      messages,
      ...(thinking && !suppressThinking ? { thinking } : {}),
    };
    const requestChars = JSON.stringify({ ...requestBody, stream: true }).length;
    let data: AnthropicRoundData;
    let status = 0;
    let phase = "headers";
    const startedAt = Date.now();
    toolHooks.debugLog(context, `ROUND ${round}: Claude request start chars=${requestChars}`);
    try {
      const res = await requestAnthropicRound(
        `${baseUrl}/v1/messages`,
        headers,
        requestBody,
        toolState.abortCtl?.signal ?? null,
        (code, mode) => {
          phase = "body";
          toolHooks.debugLog(context, `ROUND ${round}: Claude headers status=${code} mode=${mode} elapsedMs=${Date.now() - startedAt}`);
        },
      );
      status = res.status;
      data = res.data;
      toolHooks.debugLog(context, `ROUND ${round}: Claude response complete elapsedMs=${Date.now() - startedAt}`);
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
      const cause = err instanceof Error ? err.cause : undefined;
      const causeDetail = cause instanceof Error
        ? `${cause.name} ${String((cause as Error & { code?: string }).code ?? "")} ${cause.message}`
        : cause === undefined ? "" : String(cause);
      toolHooks.debugLog(
        context,
        `ROUND ${round}: Claude request failed phase=${phase} elapsedMs=${Date.now() - startedAt} ` +
          `error=${errMessage(err)} cause=${causeDetail.slice(0, 300)}`,
      );
      throw friendlyApiError({
        what: "Claude",
        settings: settingsPath(req.language, "ai"),
        raw: `${errMessage(err)} ${causeDetail}`.trim(),
        model,
        language: req.language,
      });
    }
    if (status < 200 || status >= 300) {
      console.error(
        `[ai-assistant] API ${status} · 请求 ${requestChars} 字符 · ` +
          `messages=${messages.length} tools=${chatTools.length} · 响应: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw friendlyApiError({
        what: "Claude",
        settings: settingsPath(req.language, "ai"),
        status,
        raw: data.error?.message ?? "",
        model,
        language: req.language,
      });
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

    // When text hits max_tokens, ask the model to pick up where it stopped.
    // textCarry keeps each partial for the final reply.
    if (data.stop_reason === "max_tokens") {
      const partial = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      if (partial) textCarry = textCarry ? textCarry + "\n" + partial : partial;
      if (round + 1 < AGENT_MAX_ROUNDS) {
        continuations++;
        toolHooks.debugLog(
          context,
          `ROUND ${round}: max_tokens — auto-continue ${continuations} (round ${round + 1}/${AGENT_MAX_ROUNDS})`,
        );
        if (!partial) {
          // Zero visible text = the entire budget went to thinking. Force the
          // model to act now, and never use "…" as the placeholder — the model
          // parrots it back as its whole reply (seen in the wild).
          suppressThinking = true;
          messages.push({ role: "assistant", content: "(The previous block contained internal reasoning only; no visible answer.)" });
          messages.push({
            role: "user",
            content:
              "Thinking consumed the entire token limit with no visible output. " +
              "Stop deliberating and act now: call tools or give the full reply — no ellipses, no placeholders.",
          });
        } else {
          messages.push({ role: "assistant", content: partial });
          messages.push({
            role: "user",
            content:
              "Your previous reply was cut off by the token limit — continue exactly where you stopped, without repeating yourself.",
          });
        }
        continue;
      }
      const note = TRUNC_NOTE[req.language ?? ""] ?? TRUNC_NOTE.en;
      return finishChat(context, actions, (textCarry ? textCarry + "\n\n" : "") + note);
    }

    const lastText = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    // A bare ellipsis after truncated rounds is the model parroting the old
    // continuation placeholder — drop it when real text was salvaged earlier.
    const finalText = lastText === "…" && textCarry ? "" : lastText;
    const reply = [textCarry, finalText].filter(Boolean).join("\n") || commonText(req.language, "noTextReply");
    if (
      languageCorrections < MAX_REPLY_LANGUAGE_CORRECTIONS &&
      replyNeedsLanguageCorrection(reply, req.language)
    ) {
      languageCorrections++;
      languageRewriteOnly = true;
      messages.push({ role: "assistant", content: reply });
      messages.push({ role: "user", content: languageCorrectionPrompt(req.language) });
      textCarry = "";
      continue;
    }
    const gate = await goalGate(context, req.language);
    if (gate && "inject" in gate) {
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: gate.inject });
      continue;
    }
    return finishChat(context, actions, gate ? reply + gate.appendNote : reply);
  }
  toolHooks.debugLog(context, `ROUND LIMIT reached (${AGENT_MAX_ROUNDS}); saving ${actions.length} tool actions`);
  const roundLimit = commonText(req.language, "roundLimitReached", AGENT_MAX_ROUNDS);
  return finishChat(context, actions, [textCarry, roundLimit].filter(Boolean).join("\n\n"));
}
