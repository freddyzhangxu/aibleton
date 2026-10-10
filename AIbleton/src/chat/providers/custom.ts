// The Live extension sandbox does NOT expose Node's usual globals — URL and
// Buffer must be imported explicitly per module (a bare `new URL()` crashes
// the process with ReferenceError inside request handlers).
import { URL } from "node:url";
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
import { callTool, goalGate } from "../../agent/runtime.js";
import { errMessage, friendlyApiError, settingsPath } from "../../errors.js";
import { attachImages, historyWithTools } from "../history.js";
import type { ChatRequest, ResolvedConfig } from "../config.js";
import { commonText } from "../../i18n/common.js";
import {
  languageCorrectionPrompt,
  MAX_REPLY_LANGUAGE_CORRECTIONS,
  replyNeedsLanguageCorrection,
} from "../../i18n/language.js";
import { measureAsync } from "../timing.js";
import { parseCustomResponse, type ChatCompletionsData } from "./custom-response.js";
import { logProviderUsage } from "./usage.js";
import { readChatCompletionsStream } from "./custom-stream.js";

// ---------- OpenAI-compatible chat/completions (custom endpoint) ----------

type CustomReasoningProfile =
  // defaultEffort is omitted where support is unverified: only a user-picked
  // level sends the field, the default option ("Auto") sends nothing.
  | { kind: "effort"; defaultEffort?: "low"; efforts: readonly ["low", "high", "max"] }
  | { kind: "thinking"; defaultEffort: "off"; efforts: readonly ["off", "on"] }
  // Generic OpenAI-spec levels for unlisted endpoints. No default: the field
  // rides along only when the user picked a level ("Auto" sends nothing).
  | { kind: "generic"; efforts: readonly ["low", "medium", "high"] };

/** Documented endpoint/model combinations get their native reasoning control;
 * everything else falls back to the generic OpenAI-spec levels. */
function customReasoningProfile(cfg: ResolvedConfig): CustomReasoningProfile | undefined {
  const model = cfg.model.trim().toLowerCase();
  try {
    const url = new URL(cfg.baseUrl);
    const hostname = url.hostname.toLowerCase();
    const kimiOpenPlatform = hostname === "api.moonshot.ai" || hostname === "api.moonshot.cn";
    const kimiCode =
      (hostname === "api.kimi.com" || hostname === "api.kimi.ai") &&
      url.pathname.toLowerCase().includes("/coding");
    if (model.startsWith("kimi-k3") && kimiOpenPlatform) {
      return { kind: "effort", defaultEffort: "low", efforts: ["low", "high", "max"] };
    }
    if (/^k3(?:-256k)?$/.test(model) && kimiCode) {
      return { kind: "effort", defaultEffort: "low", efforts: ["low", "high", "max"] };
    }
    if (hostname.endsWith(".volces.com")) {
      // Ark Kimi K3 always thinks, so the thinking switch does not apply; the
      // model-native effort levels ride along only when the user picks one
      // (Ark-side support is unverified — "Auto" keeps the body verbatim).
      if (model.startsWith("kimi-k3")) return { kind: "effort", efforts: ["low", "high", "max"] };
      const supportsThinkingSwitch =
        /^doubao-seed-(?:evolving|2-1-(?:pro|lite))(?:-|$)/.test(model) ||
        /^deepseek-v4-(?:1-)?(?:flash|pro)(?:-|$)/.test(model);
      if (supportsThinkingSwitch) {
        return { kind: "thinking", defaultEffort: "off", efforts: ["off", "on"] };
      }
    }
  } catch {
    // Invalid addresses are reported by the request path below.
  }
  return { kind: "generic", efforts: ["low", "medium", "high"] };
}

/** Exported for tests; the chat path uses it through the request builder. */
export function customReasoning(cfg: ResolvedConfig): Record<string, unknown> {
  const profile = customReasoningProfile(cfg);
  if (!profile) return {};
  const effort = cfg.effort ?? ("defaultEffort" in profile ? profile.defaultEffort : undefined);
  if (!effort || !profile.efforts.some((value) => value === effort)) return {};
  if (profile.kind !== "thinking") return { reasoning_effort: effort };
  const type = effort === "off" ? "disabled" : "enabled";
  return { thinking: { type } };
}

/**
 * Generic OpenAI-compatible endpoint. Speaks plain /chat/completions (the
 * flavor every third-party relay, OpenRouter and local server implements —
 * unlike /responses, which most of them lack) with no instructions field and
 * no default field mapping for arbitrary relays, while documented endpoint and
 * model combinations get their native reasoning control and every other
 * endpoint falls back to the generic OpenAI-spec levels (only sent when the
 * user picks one). Uses the same bounded provider-round loop as the others.
 */
export async function chatCustom(context: Ctx, cfg: ResolvedConfig, req: ChatRequest) {
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error(
      CUSTOM_INCOMPLETE_HINT[req.language ?? ""] ?? CUSTOM_INCOMPLETE_HINT.en);
  }
  const messages: unknown[] = [
    { role: "system", content: req.systemPrompt ?? systemPromptFor(req.language, req.selectedSkillNames, req.simpleEdit) },
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
  let languageCorrections = 0;
  let languageRewriteOnly = false;
  attachImages(messages, req, (last, images) => {
    last.content = [
      { type: "text", text: typeof last.content === "string" ? last.content : "" },
      ...images.map((im) => ({
        type: "image_url",
        image_url: { url: `data:${im.mime};base64,${im.data}` },
      })),
    ];
  });
  const tools = activeTools(req.simpleEdit).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
  const reasoning = customReasoning(cfg);

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
    const requestBody = JSON.stringify({
      model: cfg.model,
      messages,
      ...(languageRewriteOnly ? {} : { tools }),
      // Streaming cuts the perceived wait per round from "whole generation"
      // to first-token; relays that ignore stream:true still answer with the
      // old JSON shape, handled below.
      stream: true,
      ...reasoning,
    });
    let data: ChatCompletionsData;
    let status: number;
    try {
      const response = await measureAsync(`MODEL provider=custom round=${round}`, async () => {
        const res = await rawPost(new URL(`${cfg.baseUrl}/chat/completions`), {
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(cfg.authToken ? { authorization: `Bearer ${cfg.authToken}` } : {}),
          },
          body: requestBody,
          proxy: detectProxy(),
          signal: toolState.abortCtl?.signal,
        });
        const mode = res.headers["content-type"]?.toLowerCase().includes("text/event-stream")
          ? "sse"
          : "json";
        toolHooks.debugLog(context, `ROUND ${round}: custom headers status=${res.status} mode=${mode}`);
        // Error bodies parse better as plain JSON even when a gateway mislabels
        // them SSE; only successful SSE responses go through the stream reader.
        if (mode === "sse" && res.status >= 200 && res.status < 300) {
          return {
            status: res.status,
            data: await readChatCompletionsStream(res.stream, (line) => toolHooks.debugLog(context, line)),
          };
        }
        return {
          status: res.status,
          data: parseCustomResponse(res.status, await readAll(res.stream)),
        };
      }, (line) => toolHooks.debugLog(context, line));
      status = response.status;
      data = response.data;
    } catch (err) {
      // Aborted mid-request by /api/stop — keep the partial work, no error.
      if (toolState.stopRequested) return finishChat(context, actions, stopNote(req.language));
      throw friendlyApiError({
        what: "Custom",
        settings: settingsPath(req.language, "ai"),
        raw: errMessage(err),
        model: cfg.model,
        language: req.language,
      });
    }
    if (status < 200 || status >= 300 || data.error) {
      console.error(
        `[ai-assistant] custom API ${status} · 请求 ${requestBody.length} 字符 · 响应: ${JSON.stringify(data).slice(0, 500)}`,
      );
      throw friendlyApiError({
        what: "Custom",
        settings: settingsPath(req.language, "ai"),
        status,
        raw: data.error?.message ?? "",
        model: cfg.model,
        language: req.language,
      });
    }
    logProviderUsage(context, "custom", round, data.usage);
    const msg = data.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).filter((c) => c.function?.name);
    toolHooks.debugLog(context,
      `ROUND ${round}: content=${(msg.content ?? "").length} chars, tool_calls=${calls.length}`);
    if (!calls.length) {
      const reply =
        (typeof msg.content === "string" ? msg.content : "").trim() || commonText(req.language, "noTextReply");
      if (
        languageCorrections < MAX_REPLY_LANGUAGE_CORRECTIONS &&
        replyNeedsLanguageCorrection(reply, req.language)
      ) {
        languageCorrections++;
        languageRewriteOnly = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: languageCorrectionPrompt(req.language) });
        continue;
      }
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
      const resultJson = await measureAsync(
        `TOOL provider=custom round=${round} name=${call.function!.name!}`,
        () => callTool(context, actions, call.function!.name!, toolInput, req.yolo !== false),
        (line) => toolHooks.debugLog(context, line),
      );
      messages.push({ role: "tool", tool_call_id: call.id ?? "", content: resultJson });
    }
  }
  toolHooks.debugLog(context, `ROUND LIMIT reached (${AGENT_MAX_ROUNDS}); saving ${actions.length} tool actions`);
  return finishChat(context, actions, commonText(req.language, "roundLimitReached", AGENT_MAX_ROUNDS));
}
