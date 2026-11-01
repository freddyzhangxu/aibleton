import { createHash } from "node:crypto";
import { URL } from "node:url";
import type { ChatRequest, ResolvedConfig } from "../config.js";
import { speedRequestBody } from "../speed.js";
import { systemPromptFor } from "../../prompts.js";

/** Keep extension-only fields away from arbitrary Responses-compatible relays. */
function nativeResponses(cfg: ResolvedConfig): boolean {
  try {
    const url = new URL(cfg.baseUrl);
    if (url.protocol !== "https:") return false;
    const path = url.pathname.replace(/\/+$/, "");
    return (url.hostname === "api.openai.com" && path === "/v1") ||
      (cfg.chatgpt === true && url.hostname === "chatgpt.com" && path === "/backend-api/codex");
  } catch { return false; }
}

/** Stable per conversation/model, so routing can reuse its prompt cache.
 * Encrypted reasoning stays only in this turn's in-memory input array; it is
 * never put in persisted chat history or decoded by the extension. */
export function buildOpenAIRequest(
  cfg: ResolvedConfig,
  req: ChatRequest,
  input: unknown[],
  tools: unknown[],
  sessionId: string,
  rewriteOnly = false,
): Record<string, unknown> {
  const native = nativeResponses(cfg);
  const cacheKey = native ? "aibleton:" + createHash("sha256")
    .update(`${cfg.baseUrl}\0${cfg.model}\0${sessionId}`).digest("hex").slice(0, 40) : undefined;
  return {
    // Match the official client's layout: routing fields precede bulky input.
    model: cfg.model,
    ...(cfg.chatgpt ? { stream: true } : {}),
    ...speedRequestBody(cfg),
    instructions: req.systemPrompt ?? systemPromptFor(req.language, req.selectedSkillNames, req.simpleEdit),
    input,
    ...(rewriteOnly ? {} : { tools }),
    store: false,
    ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
    ...(native ? {
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: cacheKey,
      parallel_tool_calls: true,
    } : {}),
  };
}
