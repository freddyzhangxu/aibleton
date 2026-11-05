import assert from "node:assert/strict";
import test from "node:test";
import type { Ctx } from "../state.js";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { TOOLS } from "./definitions.js";
import { runTool } from "./dispatcher.js";

test("discovers and adjusts an existing Max for Live device's exposed parameters", async () => {
  let value = 0.25;
  const parameter = { name: "Depth", min: 0, max: 1, defaultValue: 0.5, isQuantized: false, valueItems: [],
    getValue: async () => value, setValue: async (next: number) => { value = next; } };
  const track = { name: "Synth", devices: [{ name: "Example Max Device", parameters: [parameter] }], arrangementClips: [], clipSlots: [] };
  const context = { application: { song: { tracks: [track], scenes: [], returnTracks: [] } }, withinTransaction: <T>(fn: () => T) => fn() } as unknown as Ctx;
  const listed = await runTool(context, "get_device_parameters", { track_index: 0, track_name: "Synth", device_name: "Example Max Device" }) as { parameters: { name: string; value: number }[] };
  assert.equal(listed.parameters[0].name, "Depth");
  assert.equal(listed.parameters[0].value, 0.25);
  await runTool(context, "set_device_parameter", { track_index: 0, track_name: "Synth", device_name: "Example Max Device", parameter: listed.parameters[0].name, value: "0.7" });
  assert.equal(value, 0.7);
});

test("instructs the assistant to inspect exposed Max for Live controls without promising patch editing", () => {
  assert.match(SYSTEM_PROMPT, /Max for Live/);
  assert.match(SYSTEM_PROMPT, /patch/i);
  assert.match(TOOLS.find((tool) => tool.name === "get_device_parameters")!.description, /Max for Live/);
});
