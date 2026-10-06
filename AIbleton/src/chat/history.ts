// Provider-facing message shaping: how a stored chat session is replayed into
// each provider's request format. These are Chat-layer concerns — the agent
// runtime (agent/runtime.ts) never sees message serialization.
import type { Attachment, ChatRequest } from "./config.js";
import type { ChatSession } from "./session.js";

const RECENT_HISTORY_CHARS = 32_000;
const EARLIER_EXCERPT_CHARS = 8_000;
const RECENT_TURNS = 4;

/** Only completed-turn payloads are compacted; persisted actions stay intact.
 * Omission markers make this evidence unsuitable for blindly replaying edits. */
function compactPayload(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (!raw || raw.length <= 2400) return value;
  const omitted: string[] = [];
  let remaining = 2400;
  const visit = (item: unknown, at: string, depth: number): unknown => {
    if (typeof item === "string") {
      const limit = Math.max(0, Math.min(600, remaining));
      remaining -= Math.min(item.length, limit);
      if (item.length <= limit) return item;
      omitted.push(`${at}: string omitted after ${limit} characters`);
      return item.slice(0, limit);
    }
    if (item === null || typeof item !== "object") return item;
    if (depth >= 6 || remaining <= 0) {
      omitted.push(`${at}: nested payload omitted`);
      return Array.isArray(item) ? [] : {};
    }
    if (Array.isArray(item)) {
      const count = Math.min(item.length, 8);
      if (count < item.length) omitted.push(`${at}: ${item.length - count} items omitted`);
      return item.slice(0, count).map((child, index) => visit(child, `${at}[${index}]`, depth + 1));
    }
    // Always preserve execution status and target coordinates ahead of bulky data.
    const priority = ["error", "executed", "verified", "status", "track_index", "track_name", "created", "clip_index", "scene_index"];
    const entries = Object.entries(item as Record<string, unknown>);
    entries.sort(([a], [b]) => {
      const rank = (key: string) => priority.includes(key) ? priority.indexOf(key) : priority.length;
      return rank(a) - rank(b);
    });
    return Object.fromEntries(entries.map(([key, child]) => {
      remaining -= key.length + 4;
      return [key, visit(child, at ? `${at}.${key}` : key, depth + 1)];
    }));
  };
  const result = visit(value, "", 0);
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, _history_omitted: omitted.slice(0, 16) }
    : { excerpt: result, _history_omitted: omitted.slice(0, 16) };
}

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
  const messages = session.messages.map((message, index) => ({
    ...message,
    index,
    actions: message.actions?.filter((action) => !action.planStep).map((action) => ({
      tool: action.tool,
      input: compactPayload(action.input),
      result: compactPayload(action.result),
    })),
  }));
  const current = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
  // Select whole user/assistant turns, so no orphaned historical tool results
  // can enter any provider's protocol. The current request is never clipped.
  const starts = messages.slice(0, current).flatMap((m, i) => m.role === "user" ? [i] : []);
  let first = current;
  let chars = 0;
  let turns = 0;
  const summarizedTurns = new Map<number, { request: string; reply: string; endIndex: number }>();
  for (let i = starts.length - 1; i >= 0 && turns < RECENT_TURNS; i--) {
    const start = starts[i];
    const group = messages.slice(start, first);
    let size = JSON.stringify(group).length;
    if (size > RECENT_HISTORY_CHARS) {
      const user = group.find((message) => message.role === "user");
      const assistant = [...group].reverse().find((message) => message.role === "assistant");
      const actions = group.flatMap((message) => message.actions ?? []);
      const failed = actions.filter((action) => action.result && typeof action.result === "object" && "error" in action.result);
      const actionSummary = actions.length
        ? `\nCompleted turn: ${actions.length} tool calls (${[...new Set(actions.map((action) => action.tool))].join(", ")}); ${failed.length} reported errors.`
        : "";
      const request = `${user?.content.slice(0, 2500) ?? "Earlier request"}${user && user.content.length > 2500 ? " [request excerpt]" : ""}${actionSummary}\nThis is abbreviated history; re-read Live and do not replay omitted tool arguments.`;
      const reply = `${assistant?.content.slice(0, 1500) ?? ""}${assistant && assistant.content.length > 1500 ? " [reply excerpt]" : ""}`;
      summarizedTurns.set(start, { request, reply, endIndex: group.at(-1)!.index + 1 });
      size = request.length + reply.length;
    }
    if (chars + size > RECENT_HISTORY_CHARS) break;
    chars += size;
    first = start;
    turns++;
  }
  if (first > 0) {
    const excerpts: string[] = [];
    let size = 0;
    for (let i = first - 1; i >= 0; i--) {
      const m = messages[i];
      const tools = m.actions?.map((a) => `${a.tool}: ${JSON.stringify(a.result).slice(0, 300)}`).join("; ") ?? "";
      const excerpt = `${m.role}: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? " [text omitted]" : ""}${tools ? `\nActions: ${tools.slice(0, 1000)}` : ""}`;
      if (size + excerpt.length > EARLIER_EXCERPT_CHARS) break;
      excerpts.unshift(excerpt);
      size += excerpt.length;
    }
    out.push(format.userText(
      "Earlier conversation excerpts (incomplete historical context; omitted text/actions are not evidence of current Set state). " +
      "Re-read Live before using old coordinates or omitted payloads.\n" + excerpts.join("\n"),
    ));
    out.push(format.assistantText("The preceding message is an incomplete history excerpt. Re-read the current Live Set before acting on old coordinates or abbreviated tool data."));
  }
  let skipUntil = -1;
  messages.slice(first).forEach((m) => {
    if (m.index < skipUntil) return;
    const summary = summarizedTurns.get(m.index);
    if (summary) {
      out.push(format.userText(summary.request));
      out.push(format.assistantText(summary.reply));
      skipUntil = summary.endIndex;
      return;
    }
    if (m.role === "user") {
      out.push(format.userText(m.content));
      return;
    }
    // An executable set_plan is the provider-level call. Its nested tool
    // actions remain in the receipt/UI, but replaying them as separate model
    // calls would duplicate the plan's own result and distort future context.
    const acts = m.actions ?? [];
    if (acts.length) out.push(...format.toolRound(acts, `hist_${m.index}_`));
    out.push(format.assistantText(m.content));
  });
  return out;
}

/**
 * Attached images ride only on the CURRENT user message (the last one after
 * history replay). Older turns keep just their "[image: name]" text marker —
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
