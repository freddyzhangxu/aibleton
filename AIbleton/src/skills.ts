/**
 * User skills — prompt fragments loaded on demand from ~/.aibleton/skills/.
 *
 * A skill is a directory containing SKILL.md:
 *
 *   ---
 *   name: dark-techno-kit
 *   description: 构建 dark techno 鼓组和 bassline
 *   triggers:
 *     - dark techno
 *     - techno drums
 *   ---
 *
 *   ## Goal / ## Workflow / ## Constraints / ## Tools / ## Verification …
 *
 * Frontmatter is optional: a plain-text SKILL.md still works — the folder
 * name becomes the skill name and the whole file is the body. Matching is
 * server-side keyword matching against the user's
 * message (auto trigger) — it does NOT depend on the model choosing to load
 * a skill, which keeps it reliable on weaker tool-calling relays. Matched
 * bodies append to the system prompt for the whole turn.
 *
 * The directory lives under the home dir on both platforms
 * (macOS ~/.aibleton/skills, Windows %USERPROFILE%\.aibleton\skills) and is
 * read through the sandbox-surviving primitives in paths.ts, so the installed
 * Extension Host (node --permission) can read it too.
 */

import * as os from "node:os";
import * as path from "node:path";
import { mkdirOutsideSandbox, readdirNames, readHomeFile } from "./paths.js";
import { currentSession } from "./chat/session.js";

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  /** SKILL.md body with the frontmatter stripped. */
  body: string;
}

const CACHE_TTL_MS = 30_000;
/** At most this many skill bodies ride one turn. */
const MAX_MATCHES = 2;
/** Per-skill body cap so a huge SKILL.md can't flood the prompt. */
const MAX_BODY_CHARS = 4000;

let cache: { at: number; skills: Skill[] } | null = null;
let dirCreated = false;

export function skillsDir(): string {
  return path.join(os.homedir(), ".aibleton", "skills");
}

/**
 * Minimal frontmatter parser for exactly the three supported fields.
 * Frontmatter is optional: without it (or without a `name` inside it) the
 * skill falls back to `fallbackName` — the folder name — so a plain-text
 * SKILL.md just works. Returns null only when no name is available at all.
 */
export function parseSkillMd(raw: string, fallbackName?: string): { name: string; description: string; triggers: string[]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) {
    if (!fallbackName) return null;
    return { name: fallbackName, description: "", triggers: [], body: raw.trim() };
  }
  const fm = m[1];
  const body = raw.slice(m[0].length).trim();
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? fallbackName;
  if (!name) return null;
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
  const triggers: string[] = [];
  const trigBlock = /^triggers:\s*\r?\n((?:[ \t]+-[ \t]*.+\r?\n?)+)/m.exec(fm)?.[1];
  if (trigBlock) {
    for (const line of trigBlock.split(/\r?\n/)) {
      const item = /^[ \t]+-[ \t]*(.+)$/.exec(line)?.[1]?.trim();
      if (item) triggers.push(item);
    }
  }
  return { name, description, triggers, body };
}

/** Scan ~/.aibleton/skills (cached 30 s — rescans pick up edits quickly). */
export function loadSkills(): Skill[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  const dir = skillsDir();
  if (!dirCreated) {
    dirCreated = true;
    try {
      mkdirOutsideSandbox(dir);
    } catch {
      // Read-only home / no child processes — skills simply stay unavailable.
    }
  }
  const skills: Skill[] = [];
  for (const entry of readdirNames(dir) ?? []) {
    const raw = readHomeFile(path.join(dir, entry, "SKILL.md"));
    if (!raw?.trim()) continue;
    const parsed = parseSkillMd(raw, entry);
    if (parsed) skills.push(parsed);
  }
  cache = { at: Date.now(), skills };
  return skills;
}

/**
 * Explicit invocation: a message starting with "/name" (what the chat UI's
 * slash picker inserts) forces that skill in, even when no trigger matches.
 */
function explicitSkill(userText: string, skills: Skill[]): Skill | null {
  const m = /^\/([\w-]+)/.exec(userText.trim());
  if (!m) return null;
  const wanted = m[1].toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted) ?? null;
}

/**
 * A skill fires when any trigger (or its name) appears in the user's
 * message, case-insensitive; an explicit "/name" prefix wins outright and
 * rides first. Most specific trigger first so a long-phrase match wins over
 * a generic word.
 */
export function matchSkills(userText: string, skills: Skill[] = loadSkills()): Skill[] {
  const forced = explicitSkill(userText, skills);
  const text = userText.toLowerCase();
  const hits: { skill: Skill; score: number }[] = [];
  for (const skill of skills) {
    if (skill === forced) continue;
    let score = 0;
    for (const t of [skill.name, ...skill.triggers]) {
      const needle = t.toLowerCase();
      if (needle && text.includes(needle)) score = Math.max(score, needle.length);
    }
    if (score > 0) hits.push({ skill, score });
  }
  const matched = hits
    .sort((a, b) => b.score - a.score)
    .map((h) => h.skill);
  return (forced ? [forced, ...matched] : matched).slice(0, MAX_MATCHES);
}

/** The latest user message of the current session (what triggered this turn). */
export function lastUserText(): string {
  const msgs = currentSession().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content;
  }
  return "";
}

/**
 * System-prompt section carrying the matched skill bodies, or "" when nothing
 * matched. Called on every agent round — caching keeps it cheap, and keeping
 * it in the system prompt means the instructions survive all rounds of the
 * turn without depending on the model re-reading anything.
 */
export function skillPromptFor(userText: string): string {
  const matched = matchSkills(userText);
  if (!matched.length) return "";
  const parts = matched.map((s) => {
    const body =
      s.body.length > MAX_BODY_CHARS
        ? s.body.slice(0, MAX_BODY_CHARS) + "\n… (skill truncated)"
        : s.body;
    return `=== Skill: ${s.name}${s.description ? ` — ${s.description}` : ""} ===\n${body}`;
  });
  return (
    "\n\nSkills matched for this request — follow their instructions, " +
    "executing the steps with the available tools (they are guidelines, " +
    "not tool calls; the user's explicit request always wins on conflict):\n\n" +
    parts.join("\n\n")
  );
}
