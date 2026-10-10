export interface ChatCompletionsData {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
  error?: { message?: string };
}

/** Keep HTTP failures visible even when a gateway returns no JSON body. */
export function parseCustomResponse(status: number, body: string): ChatCompletionsData {
  const failure = (message: string): ChatCompletionsData => ({ error: { message } });
  let data: ChatCompletionsData | null;
  try {
    data = JSON.parse(body) as ChatCompletionsData | null;
  } catch {
    return failure(!body.trim()
      ? "Custom returned an empty response body; check the OpenAI-compatible Base URL"
      : status < 200 || status >= 300
        ? body.replace(/\s+/g, " ").slice(0, 500)
        : "Custom returned invalid JSON; check the OpenAI-compatible Base URL");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return failure("Custom returned an incomplete chat/completions response");
  }
  if (status < 200 || status >= 300 || data.error) return data;
  const message = Array.isArray(data.choices) ? data.choices[0]?.message : undefined;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return failure("Custom returned an incomplete chat/completions response");
  }
  return data;
}
