import assert from "node:assert/strict";
import test from "node:test";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

type Param = {
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  isQuantized: boolean;
  valueItems: { name: string }[];
  setCalls: number[];
  getValue: () => Promise<number>;
  setValue: (value: number) => Promise<void>;
};

function parameter(name: string, choices: string[]): Param {
  const result: Param = {
    name,
    min: 0,
    max: choices.length - 1,
    defaultValue: 0,
    isQuantized: true,
    valueItems: choices.map((choice) => ({ name: choice })),
    setCalls: [],
    async getValue() { return 0; },
    async setValue(value) { result.setCalls.push(value); },
  };
  return result;
}

function contextWithDevice(parameters: Param[]): Ctx {
  const device = { name: "Auto Shift", parameters };
  const track = { name: "Lead Vocal", devices: [device], arrangementClips: [], clipSlots: [] };
  return {
    application: { song: { tracks: [track], scenes: [], returnTracks: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
}

test("uses only Live-returned Auto Shift parameter names and enum options", async () => {
  // Synthetic names stand in for the installed Live version's actual metadata.
  const scale = parameter("Mock target scale", ["Mock A", "Mock B"]);
  const context = contextWithDevice([scale]);
  const listed = await runTool(context, "get_device_parameters", {
    track_index: 0, track_name: "Lead Vocal", device_name: "Auto Shift",
  }) as { parameters: { name: string; min: number; max: number; items: string[] }[] };
  assert.deepEqual(listed.parameters, [{
    index: 0, name: "Mock target scale", value: 0, min: 0, max: 1, default: 0, items: ["Mock A", "Mock B"],
  }]);

  const discovered = listed.parameters[0];
  await runTool(context, "set_device_parameter", {
    track_index: 0, track_name: "Lead Vocal", device_name: "Auto Shift",
    parameter: discovered.name, value: discovered.items[1],
  });
  assert.deepEqual(scale.setCalls, [1]);

  await assert.rejects(() => runTool(context, "set_device_parameter", {
    track_index: 0, device_name: "Auto Shift", parameter: "unlisted root", value: "C",
  }), /参数|parameter/i);
  await assert.rejects(() => runTool(context, "set_device_parameter", {
    track_index: 0, device_name: "Auto Shift", parameter: discovered.name, value: "Unlisted option",
  }), /可选|option|不接受/i);
  assert.deepEqual(scale.setCalls, [1]);
});
