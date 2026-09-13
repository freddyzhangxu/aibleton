/**
 * skills.test.ts — SKILL.md frontmatter parsing and trigger matching.
 * Matching is pure (skill list injected), so no home-dir fixture is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { matchSkills, parseSkillMd, type Skill } from "./skills.js";

const SAMPLE = `---
name: dark-techno-kit
description: 构建 dark techno 鼓组和 bassline
triggers:
  - dark techno
  - techno drums
  - techno bass
---

## Goal
Build the kit.

## Workflow
1. load_drum_kit
`;

test("parses the three frontmatter fields and strips them from the body", () => {
  const s = parseSkillMd(SAMPLE);
  assert.ok(s);
  assert.equal(s.name, "dark-techno-kit");
  assert.equal(s.description, "构建 dark techno 鼓组和 bassline");
  assert.deepEqual(s.triggers, ["dark techno", "techno drums", "techno bass"]);
  assert.equal(s.body, "## Goal\nBuild the kit.\n\n## Workflow\n1. load_drum_kit");
});

test("accepts CRLF and missing description/triggers", () => {
  const s = parseSkillMd("---\r\nname: minimal\r\n---\r\nbody here\r\n");
  assert.ok(s);
  assert.equal(s.name, "minimal");
  assert.equal(s.description, "");
  assert.deepEqual(s.triggers, []);
  assert.equal(s.body, "body here");
});

test("falls back to the folder name when frontmatter is missing or nameless", () => {
  const plain = parseSkillMd("just do the thing\nstep by step", "my-folder");
  assert.ok(plain);
  assert.equal(plain.name, "my-folder");
  assert.equal(plain.description, "");
  assert.deepEqual(plain.triggers, []);
  assert.equal(plain.body, "just do the thing\nstep by step");

  const nameless = parseSkillMd("---\ndescription: no name\n---\nbody", "dir-name");
  assert.ok(nameless);
  assert.equal(nameless.name, "dir-name");
  assert.equal(nameless.description, "no name");
  assert.equal(nameless.body, "body");

  // No frontmatter AND no fallback → nothing to reference the skill by.
  assert.equal(parseSkillMd("no frontmatter at all"), null);
});

const skill = (over: Partial<Skill>): Skill => ({
  name: "s",
  description: "",
  triggers: [],
  body: "",
  ...over,
});

test("matches triggers and name case-insensitively", () => {
  const skills = [skill({ name: "dark-techno-kit", triggers: ["dark techno"] })];
  assert.equal(matchSkills("做一个 DARK TECHNO 的鼓", skills).length, 1);
  assert.equal(matchSkills("dark-techno-kit 用起来", skills).length, 1);
  assert.equal(matchSkills("做一个 deep house loop", skills).length, 0);
});

test("explicit '/name' invocation wins even without a trigger match", () => {
  const skills = [
    skill({ name: "dark-techno-kit", triggers: ["dark techno"] }),
    skill({ name: "mix-checklist", triggers: ["mix"] }),
  ];
  // No trigger word in the message — only the slash prefix selects it.
  assert.deepEqual(
    matchSkills("/dark-techno-kit 帮我做四小节", skills).map((s) => s.name),
    ["dark-techno-kit"],
  );
  // Unknown slash name falls back to plain trigger matching.
  assert.deepEqual(matchSkills("/nope mix 一下", skills).map((s) => s.name), ["mix-checklist"]);
});

test("longest trigger wins and matches are capped at 2", () => {
  const skills = [
    skill({ name: "generic", triggers: ["techno"] }),
    skill({ name: "specific", triggers: ["dark techno"] }),
    skill({ name: "third", triggers: ["techno bass"] }),
  ];
  const hits = matchSkills("dark techno with techno bass", skills);
  assert.deepEqual(
    hits.map((s) => s.name),
    ["specific", "third"],
  );
});
