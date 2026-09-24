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
 * name becomes the skill name, metadata may be inferred from labeled Markdown
 * fields, and the whole file remains the body. Explicit slash/name/trigger
 * matches are deterministic; if none match, skill-selector.ts asks the
 * configured provider to select relevant skills from their names and
 * descriptions. Selected bodies append to the system prompt for the turn.
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

const DESCRIPTION_LABELS = new Set([
  "技能描述",
  "描述",
  "适用场景",
  "使用场景",
  "description",
  "skill description",
  "when to use",
  "use cases",
]);
const TRIGGER_LABELS = new Set([
  "触发关键词",
  "触发词",
  "适用关键词",
  "triggers",
  "trigger keywords",
  "trigger terms",
  "trigger words",
  "keywords",
]);

function cleanMarkdownValue(value: string): string {
  return value
    .trim()
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^`(.+)`$/, "$1")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .trim();
}

function metadataLabel(value: string): string {
  return cleanMarkdownValue(value).replace(/[:：]$/, "").trim().toLowerCase();
}

function splitTriggerTerms(value: string): string[] {
  return value
    .split(/[,，、;；\n]+/)
    .map((term) => cleanMarkdownValue(term.replace(/^[-*]\s*/, "")))
    .filter(Boolean);
}

function markdownTableValue(body: string, labels: Set<string>): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cleanMarkdownValue(cell));
    if (cells.length < 2 || /^:?-{2,}:?$/.test(cells[0])) continue;
    if (labels.has(metadataLabel(cells[0]))) return cells.slice(1).join(" | ").trim();
  }
  return undefined;
}

function labeledLineValue(body: string, labels: Set<string>): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(?:>\s*)?(.*?)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (match && labels.has(metadataLabel(match[1]))) return cleanMarkdownValue(match[2]);
  }
  return undefined;
}

function labeledSectionValue(body: string, labels: Set<string>, separator = " "): string | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!heading || !labels.has(metadataLabel(heading[1]))) continue;
    const values: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s{0,3}#{1,6}\s+/.test(lines[j]); j++) {
      const line = lines[j].trim();
      if (line) values.push(line.replace(/^[-*]\s*/, ""));
    }
    if (values.length) return values.join(separator);
  }
  return undefined;
}

function inferredDescription(body: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const lines = body.split(/\r?\n/);
  const headingIndex = heading ? lines.findIndex((line) => /^\s{0,3}#{1,6}\s+/.test(line)) : -1;
  let paragraph = "";
  let inParagraph = false;
  for (let i = Math.max(0, headingIndex + 1); i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (inParagraph) break;
      continue;
    }
    if (/^\s{0,3}#{1,6}\s+/.test(line)) break;
    if (/^\|.*\|$/.test(line) || /^[-*_]{3,}$/.test(line)) {
      if (inParagraph) break;
      continue;
    }
    paragraph += `${paragraph ? " " : ""}${line.replace(/^>\s*/, "")}`;
    inParagraph = true;
    if (paragraph.length >= 500) break;
  }
  const summary = [heading?.trim(), paragraph].filter(Boolean).join(" — ");
  if (summary) return summary.slice(0, 500);
  const firstLine = lines.find((line) => line.trim() && !/^\s*---\s*$/.test(line));
  return firstLine ? cleanMarkdownValue(firstLine.replace(/^>\s*/, "")).slice(0, 500) : "";
}

function bodyMetadata(body: string): { description: string; triggers: string[] } {
  const descriptionLabels = DESCRIPTION_LABELS;
  const triggerLabels = TRIGGER_LABELS;
  const description =
    markdownTableValue(body, descriptionLabels) ??
    labeledLineValue(body, descriptionLabels) ??
    labeledSectionValue(body, descriptionLabels) ??
    inferredDescription(body);
  const triggerText =
    markdownTableValue(body, triggerLabels) ??
    labeledLineValue(body, triggerLabels) ??
    labeledSectionValue(body, triggerLabels, ", ");
  return { description, triggers: triggerText ? splitTriggerTerms(triggerText) : [] };
}

/**
 * Minimal frontmatter parser for the supported fields, with body metadata
 * fallback for skills that omit YAML frontmatter.
 * Frontmatter is optional: without it (or without a `name` inside it) the
 * skill falls back to `fallbackName` — the folder name — so a plain-text
 * SKILL.md just works. Returns null only when no name is available at all.
 */
export function parseSkillMd(raw: string, fallbackName?: string): { name: string; description: string; triggers: string[]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) {
    if (!fallbackName) return null;
    const body = raw.trim();
    const metadata = bodyMetadata(body);
    return { name: fallbackName, ...metadata, body };
  }
  const fm = m[1];
  const body = raw.slice(m[0].length).trim();
  const metadata = bodyMetadata(body);
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? fallbackName;
  if (!name) return null;
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() || metadata.description;
  const triggers: string[] = [];
  const trigBlock = /^triggers:\s*\r?\n((?:[ \t]+-[ \t]*.+\r?\n?)+)/m.exec(fm)?.[1];
  if (trigBlock) {
    for (const line of trigBlock.split(/\r?\n/)) {
      const item = /^[ \t]+-[ \t]*(.+)$/.exec(line)?.[1]?.trim();
      if (item) triggers.push(item);
    }
  }
  return { name, description, triggers: triggers.length ? triggers : metadata.triggers, body };
}

/** A skill folder whose SKILL.md exists but didn't load cleanly. */
export interface SkillProblem {
  folder: string;
  /** Ready-to-show bilingual reason (rides /api/skills to the slash picker). */
  issue: string;
}

let problems: SkillProblem[] = [];

/** Problems found by the latest scan (triggers one if never run). */
export function skillProblems(): SkillProblem[] {
  loadSkills();
  return problems;
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
  const found: SkillProblem[] = [];
  for (const entry of readdirNames(dir) ?? []) {
    const raw = readHomeFile(path.join(dir, entry, "SKILL.md"));
    if (raw !== null && raw !== undefined && !raw.trim()) {
      found.push({
        folder: entry,
        issue: "SKILL.md 是空的 — 写入技能内容或删除该文件夹 / SKILL.md is empty — add content or remove the folder",
      });
      continue;
    }
    if (!raw?.trim()) continue; // no SKILL.md — just a stray folder, not an error
    // Frontmatter opened but never closed: the whole file (broken header
    // included) silently becomes the body — flag it so the user can fix it.
    if (/^---\r?\n/.test(raw) && !/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(raw)) {
      found.push({
        folder: entry,
        issue: "frontmatter 未闭合（缺少结束的 ---），已按纯文本加载 / frontmatter never closed (missing ---), loaded as plain text",
      });
    }
    const parsed = parseSkillMd(raw, entry);
    if (parsed) skills.push(parsed);
  }
  problems = found;
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
export function skillPromptFor(userText: string, selectedNames?: string[]): string {
  const matched = selectedNames
    ? (() => {
        const byName = new Map(loadSkills().map((skill) => [skill.name, skill] as const));
        return selectedNames.map((name) => byName.get(name)).filter((skill): skill is Skill => Boolean(skill));
      })()
    : matchSkills(userText);
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
