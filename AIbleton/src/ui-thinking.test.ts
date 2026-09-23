import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const interfaceHtml = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");

test("generic thinking statuses use one English vocabulary and localized notes", () => {
  const statusMatch = interfaceHtml.match(/const THINKING_STATUS_WORDS = \[([^\]]+)\]/);
  assert.ok(statusMatch, "shared thinking status vocabulary is present");
  const statuses = [...statusMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(statuses, ["Thinking…", "Pondering…", "Mulling…"]);

  const notes = [...interfaceHtml.matchAll(/thinkingNote:\s*(['"])(.*?)\1/g)].map((match) => match[2]);
  assert.equal(notes.length, 7, "every supported language has a thinking note");
  assert.ok(notes.every((note) => note.length > 0), "every thinking note is non-empty");
  assert.ok(notes.some((note) => note.includes("可关闭窗口")), "Chinese note remains localized");
  assert.ok(notes.some((note) => note.includes("close this window")), "English note remains available");
});
