import { readAnthropicStream, type AnthropicContentBlock } from "./anthropic-stream.js";

export interface AnthropicRoundData {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
}

export interface AnthropicRoundResponse {
  status: number;
  data: AnthropicRoundData;
  mode: "sse" | "json";
}

export async function requestAnthropicRound(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | null,
  onHeaders?: (status: number, mode: "sse" | "json") => void,
): Promise<AnthropicRoundResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  const mode = res.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ? "sse"
    : "json";
  onHeaders?.(res.status, mode);
  if (res.ok && mode === "sse") {
    if (!res.body) throw new Error("Claude stream has no response body");
    return { status: res.status, data: await readAnthropicStream(res.body), mode };
  }

  // Some Anthropic-compatible relays ignore stream:true and return the old
  // JSON shape. Keep them working, while making the fallback visible in logs.
  const responseText = await res.text();
  let data: AnthropicRoundData;
  try {
    data = JSON.parse(responseText) as AnthropicRoundData;
  } catch {
    data = { error: { message: responseText.slice(0, 500) || "Claude returned invalid JSON" } };
  }
  if (res.ok && (!Array.isArray(data.content) || typeof data.stop_reason !== "string")) {
    throw new Error("Claude returned an incomplete JSON response");
  }
  return { status: res.status, data, mode };
}
