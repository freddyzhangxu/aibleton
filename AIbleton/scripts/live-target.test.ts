import assert from "node:assert/strict";
import test from "node:test";
import { runningLivePaths, selectLiveTarget } from "./live-target.js";

const live12 = "/Applications/Ableton Live 12 Beta.app";
const live13 = "/Applications/Ableton Live 13 Beta.app";

test("running Live 12 overrides a stale Live 13 env setting", () => {
  assert.equal(selectLiveTarget({ running: [live12], configured: live13 }), live12);
});

test("running Live 13 overrides a stale Live 12 env setting", () => {
  assert.equal(selectLiveTarget({ running: [live13], configured: live12 }), live13);
});

test("explicit --live takes precedence over detection and env", () => {
  assert.equal(selectLiveTarget({ running: [live13], configured: live13, explicit: live12 }), live12);
});

test("two running versions cannot be routed by --version or --live because they share developer IPC", () => {
  for (const extra of [{}, { major: "12" }, { major: "13" }, { explicit: live13 }]) {
    assert.throws(() => selectLiveTarget({ running: [live12, live13], configured: live13, ...extra }));
  }
});

test("version shortcuts select either single running version", () => {
  assert.equal(selectLiveTarget({ running: [live12], configured: live13, major: "12" }), live12);
  assert.equal(selectLiveTarget({ running: [live13], configured: live12, major: "13" }), live13);
});

test("a version shortcut never falls back to the wrong running version", () => {
  assert.throws(() => selectLiveTarget({ running: [live13], configured: live13, major: "12" }), /Live 12/);
});

test("env remains a fallback when no Live process is detected", () => {
  assert.equal(selectLiveTarget({ running: [], configured: live12 }), live12);
  assert.throws(() => selectLiveTarget({ running: [] }), /Live/);
});

test("macOS detection ignores helpers and shell commands, preserving spaces", () => {
  assert.deepEqual(runningLivePaths([
    `${live12}/Contents/MacOS/Live`,
    `${live13}/Contents/Helpers/ExtensionHost/node -e something`,
    `sh -c ${live13}/Contents/MacOS/Live`,
    `${live12}/Contents/MacOS/Live`,
  ], "darwin"), [live12]);
});

test("Windows detection selects the Live executable, not its helper", () => {
  assert.deepEqual(runningLivePaths([
    "C:\\ProgramData\\Ableton\\Live 12 Beta\\Program\\Ableton Live 12 Beta.exe",
    "C:\\ProgramData\\Ableton\\Live 12 Beta\\Program\\ExtensionHost\\node.exe",
  ], "win32"), ["C:\\ProgramData\\Ableton\\Live 12 Beta\\Program\\Ableton Live 12 Beta.exe"]);
});

test("a Windows env module path can still select a specific version", () => {
  const configured = "C:\\ProgramData\\Ableton\\Live 12 Beta\\Program\\ExtensionHost\\ExtensionHostNodeModule.node";
  assert.equal(selectLiveTarget({ running: [], configured, major: "12" }), configured);
});
