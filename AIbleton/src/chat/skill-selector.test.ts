import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as selector from "./skill-selector.js";
import type { ResolvedConfig } from "./config.js";
import type { Skill } from "../skills.js";
import { toolHooks, toolState } from "../state.js";

const cfg: ResolvedConfig = { provider: "custom", model: "test", baseUrl: "http://localhost", authToken: "", fromLocal: false };
const skills: Skill[] = [{ name: "house-producer", description: "House music", triggers: ["house"], body: "Use house rhythms" }];
const debug = toolHooks.debugLog;
afterEach(() => { toolHooks.debugLog = debug; toolState.abortCtl = null; });

function fixture() {
  assert.equal(typeof selector.createSkillSelector, "function");
  let calls = 0;
  let now = 0;
  let catalog = skills;
  let fails = false;
  toolHooks.debugLog = () => {};
  const select = selector.createSkillSelector({
    loadSkills: () => catalog,
    now: () => now,
    requestText: async () => { calls++; if (fails) throw new Error("offline"); return '["house-producer"]'; },
  });
  return { select, calls: () => calls, advance: () => { now += 301_000; }, changeCatalog: () => { catalog = [{ ...skills[0], description: "Updated genre guidance" }]; }, fail: () => { fails = true; } };
}

test("direct skills still win, while a simple tempo edit skips semantic classification", async () => {
  const f = fixture();
  assert.deepEqual(await f.select({} as never, cfg, "/house-producer set tempo to 128"), skills);
  assert.deepEqual(await f.select({} as never, cfg, "把速度改成128"), []);
  assert.equal(f.calls(), 0);
});

test("successful semantic selection is reused only for the same request, endpoint, and catalog", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.select({} as never, cfg, "做一段适合夜店的音乐"), skills);
  assert.equal(f.calls(), 1);
  await f.select({} as never, { ...cfg, baseUrl: "http://other" }, "做一段适合夜店的音乐");
  assert.equal(f.calls(), 2);
  f.changeCatalog();
  await f.select({} as never, cfg, "做一段适合夜店的音乐");
  assert.equal(f.calls(), 3);
  f.advance();
  await f.select({} as never, cfg, "做一段适合夜店的音乐");
  assert.equal(f.calls(), 4);
});

test("a stopped turn does not classify, and transient failures are not cached", async () => {
  const f = fixture();
  toolState.abortCtl = new AbortController();
  toolState.abortCtl.abort();
  assert.deepEqual(await f.select({} as never, cfg, "做一段适合夜店的音乐"), []);
  assert.equal(f.calls(), 0);
  toolState.abortCtl = null;
  f.fail();
  await f.select({} as never, cfg, "做一段适合夜店的音乐");
  await f.select({} as never, cfg, "做一段适合夜店的音乐");
  assert.equal(f.calls(), 2);
});
