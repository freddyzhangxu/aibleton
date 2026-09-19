import * as fs from "node:fs";
import * as path from "node:path";
import {
  mkdirOutsideSandbox,
  readHomeFile,
  storeFallbackPath,
  writeHomeFile,
} from "../paths.js";
import type { Ctx } from "../state.js";
import { turnGoalOutcome } from "../agent/turnoutcome.js";
import { buildTurnReceipt, type ToolAction, type TurnReceipt } from "./receipt.js";

// ---------- Chat sessions (server-side, persisted) ----------

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ToolAction[];
  receipt?: TurnReceipt;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: HistoryMessage[];
}

let sessions: ChatSession[] = [];
let currentId: string | null = null;

/** Set when the SDK storage dir turns out to be missing/unwritable. */
let storeFileOverride: string | null = null;

/** Removes complete Unicode Emoji sequences from an assistant reply. */
export function stripEmoji(text: string): string {
  return text.replace(
    /(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Emoji_Modifier})/gu,
    "",
  );
}

function sanitizeAssistantMessages(messages: HistoryMessage[]): { messages: HistoryMessage[]; changed: boolean } {
  let changed = false;
  const clean = messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content !== "string") return message;
    const content = stripEmoji(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return { messages: clean, changed };
}

export function storeFilePath(context: Ctx): string {
  if (storeFileOverride) return storeFileOverride;
  const dir = context.environment.storageDirectory;
  // The beta may return undefined for storageDirectory — fall back to a
  // stable per-user location so sessions actually persist.
  return dir ? path.join(dir, "chats.json") : storeFallbackPath();
}

export function createSession(): ChatSession {
  const session: ChatSession = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  sessions.unshift(session);
  currentId = session.id;
  return session;
}

export function currentSession(): ChatSession {
  return sessions.find((s) => s.id === currentId) ?? createSession();
}

export function loadStore(context: Ctx) {
  const candidates = [...new Set([storeFilePath(context), storeFallbackPath()])];
  let loadedFrom: string | null = null;
  let migratedEmoji = false;
  for (const file of candidates) {
    try {
      const raw = readHomeFile(file);
      if (!raw) continue;
      const data = JSON.parse(raw) as {
        sessions?: ChatSession[];
        currentId?: string;
      };
      if (Array.isArray(data.sessions)) {
        sessions = data.sessions.filter(
          (s) => s && typeof s.id === "string" && Array.isArray(s.messages),
        ).map((session) => {
          const cleaned = sanitizeAssistantMessages(session.messages);
          if (cleaned.changed) migratedEmoji = true;
          return cleaned.changed ? { ...session, messages: cleaned.messages } : session;
        });
        currentId = typeof data.currentId === "string" ? data.currentId : (sessions[0]?.id ?? null);
        loadedFrom = file;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  // Migrate the previous single-file history, if any.
  if (sessions.length === 0) {
    for (const file of candidates) {
      try {
        const legacyRaw = readHomeFile(path.join(path.dirname(file), "chat-history.json"));
        if (!legacyRaw) continue;
        const legacy = JSON.parse(legacyRaw) as unknown;
        if (Array.isArray(legacy) && legacy.length) {
          const session = createSession();
          const imported = legacy.filter(
            (m): m is HistoryMessage =>
              !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          );
          const cleaned = sanitizeAssistantMessages(imported);
          session.messages = cleaned.messages;
          if (cleaned.changed) migratedEmoji = true;
          const first = session.messages.find((m) => m.role === "user");
          session.title = first ? first.content.slice(0, 24) : "导入的对话";
          break;
        }
      } catch {
        // Nothing to migrate here.
      }
    }
  }
  // Old assistant messages must not reappear in the UI or provider history
  // with Emoji after the rule is introduced. Persist this one-time migration.
  if (migratedEmoji) saveStore(context);
  console.log(`[ai-assistant] 会话存储: ${loadedFrom ?? storeFilePath(context)}`);
}

export function saveStore(context: Ctx) {
  const file = storeFilePath(context);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions, currentId }));
    return;
  } catch {
    // Primary location unwritable — fall through to the home fallback, reached
    // via the same child-process escape as readHomeFile/writeHomeFile.
  }
  const fallback = storeFallbackPath();
  if (file !== fallback) storeFileOverride = fallback;
  try {
    mkdirOutsideSandbox(path.dirname(fallback));
    writeHomeFile(fallback, JSON.stringify({ sessions, currentId }));
    if (file !== fallback) console.log(`[ai-assistant] 会话存储回退到: ${fallback}`);
  } catch {
    // In-memory sessions still work for this run.
  }
}

/** Directory chats.json lives in — the same base the other per-user stores
 * (providers.json, memory.json) resolve against. */
export function chatStoreDir(context: Ctx): string {
  return storeFileOverride
    ? path.dirname(storeFileOverride)
    : context.environment.storageDirectory || path.dirname(storeFallbackPath());
}

/** Read-only view for the /api/sessions listing. */
export function listSessions(): ChatSession[] {
  return sessions;
}

/** Point the current session at `id`; null when it does not exist. */
export function switchSession(id: string): ChatSession | null {
  const target = sessions.find((s) => s.id === id);
  if (!target) return null;
  currentId = target.id;
  return target;
}

export function deleteSession(id: string): void {
  sessions = sessions.filter((s) => s.id !== id);
  if (currentId === id) currentId = sessions[0]?.id ?? null;
}

/** Shared tail of a completed chat: persist the assistant reply + tool actions. */
export function finishChat(
  context: Ctx,
  actions: ToolAction[],
  reply: string,
) {
  const session = currentSession();
  const cleanReply = stripEmoji(reply);
  const receipt = buildTurnReceipt(actions, turnGoalOutcome());
  session.messages.push({ role: "assistant", content: cleanReply, actions, ...(receipt ? { receipt } : {}) });
  session.updatedAt = Date.now();
  saveStore(context);
  return { reply: cleanReply, actions };
}

/** Cap a tool-result payload the same way for live calls and history replay. */
export function truncateResult(resultJson: string): string {
  if (resultJson.length <= 6000) return resultJson;
  return (
    resultJson.slice(0, 6000) +
    `…（结果过大已截断，共 ${resultJson.length} 字符。请用 filter 缩小查询范围）`
  );
}
