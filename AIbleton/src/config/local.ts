import * as os from "node:os";
import * as path from "node:path";
import { readHomeFile } from "../paths.js";

// ---------- Local CLI configs (Claude Code / Codex / Gemini) ----------

export type Provider = "claude" | "codex" | "gemini" | "custom";

export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  custom: "Custom",
};

export interface LocalConfig {
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  model?: string;
  /** Codex ChatGPT-account mode: JWT for chatgpt.com/backend-api/codex. */
  accountId?: string;
  refreshToken?: string;
  chatgpt?: boolean;
  reasoningEffort?: string;
}

const configCache: Partial<Record<Provider, LocalConfig | null>> = {};

function loadClaudeCodeConfig(): LocalConfig | null {
  if ("claude" in configCache) return configCache.claude ?? null;
  const raw = readHomeFile(path.join(os.homedir(), ".claude", "settings.json"));
  if (raw) {
    try {
      const settings = JSON.parse(raw) as {
        env?: Record<string, string>;
        model?: string;
      };
      const env = settings.env ?? {};
      configCache.claude = {
        baseUrl: env.ANTHROPIC_BASE_URL,
        authToken: env.ANTHROPIC_AUTH_TOKEN,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL || settings.model,
      };
    } catch {
      configCache.claude = null;
    }
  } else {
    configCache.claude = null;
  }
  return configCache.claude ?? null;
}

/**
 * Codex CLI: ~/.codex/auth.json holds either OPENAI_API_KEY (API-key mode) or
 * ChatGPT OAuth tokens (subscription mode — access_token is a JWT for the
 * chatgpt.com backend, refreshable via refresh_token). Model and reasoning
 * effort come from ~/.codex/config.toml.
 */
function loadCodexConfig(): LocalConfig | null {
  if ("codex" in configCache) return configCache.codex ?? null;
  let apiKey: string | undefined;
  let accessToken: string | undefined;
  let accountId: string | undefined;
  let refreshToken: string | undefined;
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  const authRaw = readHomeFile(path.join(os.homedir(), ".codex", "auth.json"));
  if (authRaw) {
    try {
      const auth = JSON.parse(authRaw) as {
        OPENAI_API_KEY?: string | null;
        tokens?: { access_token?: string; account_id?: string; refresh_token?: string };
      };
      if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
        apiKey = auth.OPENAI_API_KEY;
      }
      accessToken = auth.tokens?.access_token || undefined;
      accountId = auth.tokens?.account_id || undefined;
      refreshToken = auth.tokens?.refresh_token || undefined;
    } catch {
      // Unparseable auth.json — fall through to env vars at resolve time.
    }
  }
  const toml = readHomeFile(path.join(os.homedir(), ".codex", "config.toml"));
  if (toml) {
    const m = /^model\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) model = m[1];
    const effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml);
    if (effort) reasoningEffort = effort[1];
  }
  const hasAuth = Boolean(apiKey || accessToken || refreshToken);
  configCache.codex = hasAuth || model
    ? {
        apiKey,
        authToken: accessToken,
        accountId,
        refreshToken,
        model,
        reasoningEffort,
        chatgpt: !apiKey && Boolean(accessToken || refreshToken),
      }
    : null;
  return configCache.codex;
}

/** Gemini CLI: API key in ~/.gemini/.env (GEMINI_API_KEY=…), env vars win. */
function loadGeminiConfig(): LocalConfig | null {
  if ("gemini" in configCache) return configCache.gemini ?? null;
  let apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
  if (!apiKey) {
    const envFile = readHomeFile(path.join(os.homedir(), ".gemini", ".env"));
    if (envFile) {
      const m = /^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*"?([^"\r\n]+)"?/m.exec(envFile);
      if (m) apiKey = m[1].trim();
    }
  }
  configCache.gemini = apiKey ? { apiKey } : null;
  return configCache.gemini;
}

export function loadLocalConfig(provider: Provider): LocalConfig | null {
  if (provider === "codex") return loadCodexConfig();
  if (provider === "gemini") return loadGeminiConfig();
  // Custom endpoints have no CLI to autodetect from — settings-UI config only.
  if (provider === "custom") return null;
  return loadClaudeCodeConfig();
}

/** Token refresh writes the new access/refresh tokens back into the cached
 * codex config so this process keeps using the fresh JWT. */
export function updateCodexTokenCache(accessToken: string, refreshToken?: string): void {
  if (configCache.codex) {
    configCache.codex.authToken = accessToken;
    if (refreshToken) configCache.codex.refreshToken = refreshToken;
  }
}
