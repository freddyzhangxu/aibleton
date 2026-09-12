import { loadLocalConfig, type LocalConfig, type Provider } from "../config/local.js";
import { toolHooks } from "../state.js";

export interface Attachment {
  name: string;
  mime: string;
  text?: string;
  data?: string;
  /** "midi" | "als" — binary music files parsed by fileparsers.ts. */
  kind?: string;
}

export interface ChatRequest {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  /** Reasoning effort override: "low" | "medium" | "high" (empty = provider default). */
  effort?: string;
  /** false = ask the user before any Set-modifying tool call (default true = run freely). */
  yolo?: boolean;
  attachments?: Attachment[];
  /** Audio-generation provider config from the settings UI (same per-request pattern as apiKey). */
  audio?: { provider?: string; apiKey?: string; baseUrl?: string };
}

export interface ResolvedConfig {
  provider: Provider;
  baseUrl: string;
  authToken: string;
  model: string;
  fromLocal: boolean;
  /** Codex ChatGPT-account mode. */
  accountId?: string;
  refreshToken?: string;
  chatgpt?: boolean;
  reasoningEffort?: string;
  /** UI-selected effort, mapped per provider (claude: thinking budget; gemini: thinkingBudget). */
  effort?: string;
}

export function resolveConfig(req: ChatRequest): ResolvedConfig {
  const provider: Provider =
    req.provider === "codex" || req.provider === "gemini" || req.provider === "custom"
      ? req.provider
      : "claude";
  // Manual settings-UI config wins over CLI autodetect; per-request fields win over both.
  const local: LocalConfig = { ...(loadLocalConfig(provider) ?? {}), ...(toolHooks.getManualConfig(provider) ?? {}) };
  const fromLocal = !req.apiKey && Boolean(local.authToken || local.apiKey);

  if (provider === "custom") {
    // Generic OpenAI-compatible endpoint (Grok / DeepSeek / Kimi / OpenRouter /
    // Ollama / vLLM …): chat/completions protocol. No CLI autodetect, no
    // effort mapping, no built-in defaults — baseUrl and model are required,
    // the key may stay empty for local servers that don't check it.
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || "").replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || local.authToken || "",
      model: req.model || local.model || "",
      fromLocal,
    };
  }
  if (provider === "codex") {
    // ChatGPT-account tokens only work against the chatgpt.com backend;
    // plain API keys go to api.openai.com (or a user-supplied relay).
    const chatgpt =
      !req.apiKey && !req.baseUrl && !local.apiKey &&
      Boolean(local.chatgpt || local.authToken || local.refreshToken);
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || process.env.OPENAI_BASE_URL ||
        (chatgpt ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1")).replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || local.authToken || process.env.OPENAI_API_KEY || "",
      model: req.model || local.model || "gpt-5-codex",
      fromLocal,
      accountId: chatgpt ? local.accountId : undefined,
      refreshToken: chatgpt ? local.refreshToken : undefined,
      chatgpt,
      // UI effort selector wins over the CLI config file.
      reasoningEffort: req.effort || local.reasoningEffort,
      effort: req.effort,
    };
  }
  if (provider === "gemini") {
    return {
      provider,
      baseUrl: (req.baseUrl || local.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
      authToken: req.apiKey || local.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
      model: req.model || local.model || "gemini-flash-latest",
      fromLocal,
      effort: req.effort,
    };
  }
  return {
    provider,
    baseUrl: (req.baseUrl || local.baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    authToken: req.apiKey || local.authToken || local.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
    model: req.model || local.model || "claude-sonnet-5",
    fromLocal,
    effort: req.effort,
  };
}
