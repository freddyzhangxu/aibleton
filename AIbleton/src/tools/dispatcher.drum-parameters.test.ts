import assert from "node:assert/strict";
import test from "node:test";
import { DrumRack } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

type Param = {
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  isQuantized: boolean;
  valueItems: { name: string }[];
  value: number;
  setCalls: number[];
  getValue: () => Promise<number>;
  setValue: (value: number) => Promise<void>;
};

function param(name: string, value: number, extra?: Partial<Param>): Param {
  const out: Param = {
    name, value, min: 0, max: 1, defaultValue: 0.5, isQuantized: false, valueItems: [], setCalls: [],
    async getValue() { return out.value; },
    async setValue(next) { out.setCalls.push(next); out.value = next; },
    ...extra,
  };
  return out;
}

function fixture(params: Param[]) {
  const device = { name: "Reverb", parameters: params };
  const chain = { receivingNote: 38, devices: [device] };
  const rack = Object.create(DrumRack.prototype) as DrumRack<"1.0.0">;
  Object.defineProperties(rack, { name: { value: "Kit", configurable: true }, chains: { value: [chain], configurable: true } });
  const context = {
    application: { song: { tracks: [{ name: "Drums", devices: [rack] }], scenes: [] } },
  } as unknown as Ctx;
  return { context, params };
}

test("get_drum_pad_device_parameters filters and presents enum choices", async () => {
  const decay = param("Decay Time", 0.4);
  const quality = param("Quality", 1, { isQuantized: true, valueItems: [{ name: "Eco" }, { name: "High" }] });
  const { context } = fixture([decay, quality]);
  const result = await runTool(context, "get_drum_pad_device_parameters", {
    track_index: 0, pad_note: 38, device_index: 0, filter: "quality",
  });
  assert.deepEqual(result, {
    rack: "Kit", pad_note: 38, device: "Reverb", device_index: 0, parameterCount: 2,
    parameters: [{ index: 1, name: "Quality", value: 1, min: 0, max: 1, default: 0.5, items: ["Eco", "High"] }],
    track_index: 0,
  });
});

test("set_drum_pad_device_parameter resolves enums and default values", async () => {
  const quality = param("Quality", 0, { defaultValue: 1, isQuantized: true, valueItems: [{ name: "Eco" }, { name: "High" }] });
  const { context } = fixture([quality]);
  await runTool(context, "set_drum_pad_device_parameter", {
    track_index: 0, pad_note: 38, device_index: 0, parameter: "quality", value: "high",
  });
  await runTool(context, "set_drum_pad_device_parameter", {
    track_index: 0, pad_note: 38, device_index: 0, parameter: "quality", value: "default",
  });
  assert.deepEqual(quality.setCalls, [1, 1]);
});

test("set_drum_pad_device_parameters applies valid entries despite a failed entry", async () => {
  const decay = param("Decay", 0.2, { max: 0.8 });
  const { context } = fixture([decay]);
  const result = await runTool(context, "set_drum_pad_device_parameters", {
    track_index: 0, pad_note: 38, device_index: 0,
    params: [{ parameter: "decay", value: "2" }, { parameter: "missing", value: "1" }],
  }) as { applied: { parameter: string; value: number }[]; failed: { parameter: string }[] };
  assert.deepEqual(decay.setCalls, [0.8]);
  assert.deepEqual(result.applied, [{ parameter: "Decay", value: 0.8 }]);
  assert.deepEqual(result.failed.map((item) => item.parameter), ["missing"]);
});
