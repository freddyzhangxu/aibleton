import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");
const start = html.indexOf("// ----- speed control -----");
const end = html.indexOf("// ----- effort control -----", start);

function fixture() {
  assert.ok(start >= 0 && end > start, "speed control is available");
  const attrs: Record<string, string> = {};
  let listener: () => Promise<void>;
  const button = {
    textContent: "", title: "", disabled: true,
    classList: { toggle() {} },
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    addEventListener: (_name: string, fn: typeof listener) => { listener = fn; },
  };
  const hint = { textContent: "" };
  const status = { textContent: "", classList: { toggle() {} } };
  const writes: unknown[] = [];
  let saved = false;
  let supported = true;
  let failWrite = false;
  const context = {
    document: { getElementById: (id: string) => id === "speedStatus" ? status : id === "speedHint" ? hint : button },
    currentProvider: "codex", cfgInputs: { baseUrl: { value: "" } },
    currentModelId: () => "gpt-5.6-sol", URLSearchParams,
    t: (key: string) => key === "speedActualResult" ? "speedActualResult {state}" : key,
    addMsg: () => {}, renderModelSummary() {},
    fetch: async (_url: string, init?: { body: string }) => {
      if (init) {
        const body = JSON.parse(init.body); writes.push(body);
        if (!failWrite) saved = body.config.fastMode;
        return { ok: !failWrite, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ kind: supported ? "openai" : null, reason: "model", scope: "codex:test", enabled: saved }) };
    },
  };
  runInNewContext(html.slice(start, end), context);
  const run = (s: string) => runInNewContext(s, context) as Promise<void>;
  return { button, status, attrs, writes, context, run, click: () => listener(),
    unsupported: () => { supported = false; }, fail: () => { failWrite = true; } };
}

test("speed button persists on/off, restores server preference, and retains old state when save fails", async () => {
  const f = fixture();
  await f.run("refreshSpeed(true)");
  assert.equal(f.attrs["aria-pressed"], "false");
  assert.equal(f.button.disabled, false);
  await f.click();
  assert.deepEqual(f.writes[0], { provider: "codex", config: { fastMode: true } });
  assert.equal(f.attrs["aria-pressed"], "true");
  await f.run("refreshSpeed(true)");
  assert.equal(f.attrs["aria-pressed"], "true");
  f.fail();
  await f.click();
  assert.equal(f.attrs["aria-pressed"], "true");
});

test("unsupported selections cannot send paid speed requests and actual fallback is visible", async () => {
  const f = fixture();
  await f.run("refreshSpeed(true)");
  await f.click();
  await f.run("updateSpeedStatus({ scope: 'codex:test', state: 'standard' })");
  assert.equal(f.attrs["aria-pressed"], "true");
  assert.equal(f.attrs["aria-checked"], "true");
  assert.doesNotMatch(f.button.textContent, /speedStandard/);
  assert.match(f.status.textContent, /speedStandard/);
  f.unsupported();
  await f.run("refreshSpeed(true)");
  assert.equal(f.button.disabled, true);
  assert.equal(f.attrs["aria-pressed"], "false");
  await f.click();
  assert.equal(f.writes.length, 1);
});
