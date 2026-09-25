import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

export interface AnthropicContentBlock extends Record<string, unknown> {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicStreamData {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

/** Rebuild the final Messages response while consuming its SSE body. */
export async function readAnthropicStream(stream: AsyncIterable<Uint8Array>): Promise<AnthropicStreamData> {
  const decoder = new StringDecoder("utf8");
  const blocks: (AnthropicContentBlock | undefined)[] = [];
  const openBlocks = new Set<number>();
  const toolInputs = new Map<number, string>();
  let pending = "";
  let eventName = "";
  let dataLines: string[] = [];
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = "";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const name = eventName;
    eventName = "";
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : name;

    if (type === "error") {
      const error = event.error as { type?: string; message?: string } | undefined;
      throw new Error(`${error?.type ?? "stream_error"}: ${error?.message ?? "Claude stream failed"}`);
    }
    if (type === "ping") return;
    if (type === "message_start") {
      started = true;
      return;
    }
    if (!started) throw new Error("Claude SSE event arrived before message_start");

    if (type === "content_block_start") {
      const index = event.index;
      const block = event.content_block;
      if (!Number.isInteger(index) || (index as number) < 0 ||
          !block || typeof block !== "object" || typeof (block as Record<string, unknown>).type !== "string" ||
          blocks[index as number]) {
        throw new Error("Invalid Claude content_block_start event");
      }
      blocks[index as number] = { ...(block as AnthropicContentBlock) };
      openBlocks.add(index as number);
      return;
    }
    if (type === "content_block_delta") {
      const index = event.index as number;
      const block = blocks[index];
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!openBlocks.has(index) || !block || !delta || typeof delta !== "object") {
        throw new Error("Invalid Claude content_block_delta event");
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = (block.text ?? "") + delta.text;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        toolInputs.set(index, (toolInputs.get(index) ?? "") + delta.partial_json);
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = String(block.thinking ?? "") + delta.thinking;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = String(block.signature ?? "") + delta.signature;
      }
      return;
    }
    if (type === "content_block_stop") {
      const index = event.index as number;
      const block = blocks[index];
      if (!openBlocks.has(index) || !block) throw new Error("Invalid Claude content_block_stop event");
      openBlocks.delete(index);
      return;
    }
    if (type === "message_delta") {
      const delta = event.delta as { stop_reason?: unknown } | undefined;
      if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
      return;
    }
    if (type === "message_stop") stopped = true;
  };

  const readLines = () => {
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const rawLine = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) {
        dispatch();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  };

  for await (const chunk of stream) {
    pending += decoder.write(Buffer.from(chunk));
    readLines();
  }
  pending += decoder.end();
  readLines();
  if (!stopped || !stopReason || openBlocks.size ||
      Array.from({ length: blocks.length }, (_, index) => !blocks[index]).some(Boolean)) {
    throw new Error("Claude stream ended before message_stop or complete content");
  }
  for (const [index, input] of toolInputs) {
    if (!input.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      // The outer loop discards this last block on max_tokens and asks the
      // model to issue it again. A partial JSON value is expected there.
      if (stopReason === "max_tokens" && index === blocks.length - 1 && blocks[index]?.type === "tool_use") {
        continue;
      }
      throw new Error("Invalid Claude tool input JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Claude tool input JSON");
    }
    blocks[index]!.input = parsed as Record<string, unknown>;
  }
  return { content: blocks as AnthropicContentBlock[], stop_reason: stopReason };
}
