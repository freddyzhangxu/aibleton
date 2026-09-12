// Provider-facing message shaping: how a stored chat session is replayed into
// each provider's request format. These are Chat-layer concerns — the agent
// runtime (agent/runtime.ts) never sees message serialization.
import type { Attachment, ChatRequest } from "./config.js";
import type { ChatSession } from "./session.js";

/**
 * Replay stored messages WITH their tool rounds reconstructed.
 * Weaker models imitate history: if past assistant turns claim "done" with no
 * visible tool calls, the model learns to pretend instead of calling tools.
 * Re-inserting the tool-call/tool-result structure keeps it honest.
 */
export function historyWithTools(
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
export function attachImages(
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
