import assert from "node:assert/strict";
import { test } from "node:test";
import * as config from "./config.js";

test("only unambiguous single tempo or track mixer edits use the fast path", () => {
  assert.equal(typeof config.simpleEditKind, "function");
  for (const text of ["把速度改成128", "请把 BPM 设置为 124", "Set the tempo to 128 BPM."]) {
    assert.equal(config.simpleEditKind(text), "tempo", text);
  }
  for (const text of ["把第2轨的音量调到0.6", "Set the volume of Bass to 0.6"]) {
    assert.equal(config.simpleEditKind(text), "mixer", text);
  }
  for (const text of ["做一首128BPM的house", "把速度改成128，并加一段bass", "把速度改成128\n不要动第2轨", "Make the bass dreamier", "继续", "/producer set tempo to 128", "Set the master volume to 0.6"]) {
    assert.equal(config.simpleEditKind(text), undefined, text);
  }
});

test("automatic low effort preserves explicit settings, complex-task defaults, and unsupported endpoints", () => {
  assert.equal(typeof config.withTaskEffort, "function");
  const cfg: config.ResolvedConfig = { provider: "codex", model: "test", baseUrl: "http://local", authToken: "", fromLocal: false };
  assert.equal(config.withTaskEffort(cfg, {}, "Set tempo to 128").reasoningEffort, "low");
  assert.equal(config.withTaskEffort({ ...cfg, reasoningEffort: "high" }, {}, "Set tempo to 128").reasoningEffort, "high");
  assert.equal(config.withTaskEffort({ ...cfg, effort: "max" }, { effort: "max" }, "Set tempo to 128").effort, "max");
  assert.equal(config.withTaskEffort(cfg, {}, "Make a complete house arrangement"), cfg);
  const custom = { ...cfg, provider: "custom" as const };
  assert.equal(config.withTaskEffort(custom, {}, "Set tempo to 128"), custom, "strict compatible relays do not receive extra API fields");
  assert.equal(config.withTaskEffort({ ...custom, baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }, {}, "Set tempo to 128").effort, "low");
  assert.equal(config.withTaskEffort({ ...custom, effort: "high" }, {}, "Set tempo to 128").effort, "high");
  const claude = { ...cfg, provider: "claude" as const };
  assert.equal(config.withTaskEffort(claude, {}, "Set tempo to 128"), claude, "do not enable extra thinking when it was disabled");
});
