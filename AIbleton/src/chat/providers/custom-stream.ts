// The Live extension sandbox does NOT expose Node's usual globals — StringDecoder
// must be imported explicitly per module.
import { StringDecoder } from "node:string_decoder";
import type { ChatCompletionsData } from "./custom-response.js";

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * Consume a chat/completions SSE body (stream:true) and rebuild the message
 * the non-streaming response would have carried, so the provider loop stays
 * transport-agnostic. StringDecoder keeps multi-byte UTF-8 intact across
 * chunk boundaries (same fix as readAnthropicStream).
 *
 * Relay quirks tolerated on purpose (OpenRouter, one-api, ark gateways):
 * - `reasoning_content` deltas (DeepSeek/K3-style thinking) are counted for
 *   the log but never enter the visible reply.
 * - A missing trailing [DONE] is accepted only when finish_reason arrived —
 *   some gateways drop the terminator.
 * - A plain JSON error body despite the SSE request is surfaced verbatim.
 */
export async function readChatCompletionsStream(
  stream: AsyncIterable<Uint8Array>,
  log?: (line: string) => void,
): Promise<ChatCompletionsData> {
  const decoder = new StringDecoder("utf8");
  const toolCalls = new Map<number, ToolCallAcc>();
  let content = "";
  let reasoningChars = 0;
  let finishReason: string | null = null;
  let sawDone = false;
  let events = 0;
  let rawNonSse = "";
  let pending = "";

  const handleData = (payload: string) => {
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let evt: {
      choices?: {
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string | null;
      }[];
      error?: { message?: string };
    };
    try {
      evt = JSON.parse(payload) as typeof evt;
    } catch {
      return; // keepalive noise from the gateway
    }
    if (evt.error?.message) throw new Error(evt.error.message);
    const choice = Array.isArray(evt.choices) ? evt.choices[0] : undefined;
    if (!choice) return; // usage-only tail chunks carry no choices
    events++;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
    for (const call of delta.tool_calls ?? []) {
      const index = typeof call.index === "number" && call.index >= 0 ? call.index : 0;
      const acc = toolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) acc.id = call.id;
      if (call.function?.name) acc.name += call.function.name;
      if (call.function?.arguments) acc.args += call.function.arguments;
      toolCalls.set(index, acc);
    }
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  };

  const readLines = () => {
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const rawLine = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      if (line.startsWith("data:")) {
        handleData(line.slice(5).trim());
      } else if (!line.startsWith(":")) {
        // Gateways answer auth/quota failures with a plain JSON body despite
        // the SSE request — keep it so the caller can surface the message.
        rawNonSse += line;
      }
    }
  };

  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    readLines();
  }
  pending += decoder.end();
  readLines();
  // A body without a trailing newline never entered the line loop.
  if (pending.trim() && !pending.trim().startsWith("data:")) rawNonSse += pending.trim();

  if (!events) {
    if (rawNonSse) {
      try {
        const body = JSON.parse(rawNonSse) as { error?: { message?: string } };
        if (body.error?.message) throw new Error(body.error.message);
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`The custom endpoint returned a non-SSE response: ${rawNonSse.slice(0, 300)}`);
        }
        throw err;
      }
    }
    throw new Error("Connection dropped before the custom endpoint answered");
  }
  // A few relays omit [DONE], but a normal finish_reason still proves the
  // completion. Events alone do not: a clean EOF can be a truncated tool call.
  if (!sawDone && finishReason === null) {
    throw new Error("Connection dropped before the custom endpoint completed the response");
  }
  log?.(
    `custom SSE ended: events=${events} content=${content.length} chars ` +
      `reasoning=${reasoningChars} chars tool_calls=${toolCalls.size} ` +
      `finish_reason=${finishReason ?? "none"}${sawDone ? "" : " (no [DONE] — using aggregated deltas)"}`,
  );
  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc], n) => {
      if (!acc.name.trim()) throw new Error("Custom endpoint completed a tool call without a function name");
      let args: unknown;
      try {
        args = JSON.parse(acc.args);
      } catch {
        throw new Error(`Custom endpoint completed a tool call with invalid arguments for ${acc.name}`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`Custom endpoint completed a tool call with non-object arguments for ${acc.name}`);
      }
      return {
        id: acc.id || `call_${n}`,
        // Required by strict gateways (ark 400s on echo without it): the
        // provider loop replays this message verbatim into the next round.
        type: "function",
        function: { name: acc.name, arguments: JSON.stringify(args) },
      };
    });
  return {
    choices: [
      {
        message: {
          content: content || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
      },
    ],
  };
}
