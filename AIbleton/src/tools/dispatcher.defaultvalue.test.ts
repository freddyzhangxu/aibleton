import assert from "node:assert/strict";
import test from "node:test";
import { toolState, type Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

type ParamSpy = {
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  isQuantized: boolean;
  valueItems: { name: string }[];
  setCalls: number[];
  getValue: () => Promise<number>;
  setValue: (v: number) => Promise<void>;
};

function param(name: string, defaultValue: number, extra?: Partial<ParamSpy>): ParamSpy {
  return {
    name,
    min: 0,
    max: 1000,
    defaultValue,
    isQuantized: false,
    valueItems: [],
    setCalls: [],
    async getValue() { return 0; },
    async setValue(v: number) { this.setCalls.push(v); },
    ...extra,
  };
}

function contextWithDevice(params: ParamSpy[]): Ctx {
  const device = { name: "Auto Filter", parameters: params };
  const track = {
    name: "Bass",
    devices: [device],
    arrangementClips: [],
    clipSlots: [],
  };
  const song = { tracks: [track], scenes: [], returnTracks: [] };
  return {
    application: { song },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
}

test('set_device_parameter value "default" resets to DeviceParameter.defaultValue', async () => {
  const freq = param("Frequency", 440);
  const context = contextWithDevice([freq]);
  toolState.activeDeleteAuthorization = undefined;
  const out = (await runTool(context, "set_device_parameter", {
    track_index: 0,
    device_index: 0,
    parameter: "freq",
    value: "default",
  })) as { device: string; parameter: string; value: number };
  assert.deepEqual(freq.setCalls, [440]);
  assert.equal(out.parameter, "Frequency");
  assert.equal(out.value, 440);
});

test('"default" keyword is case-insensitive and clamps to the param range', async () => {
  // defaultValue outside [min, max] must be clamped by setParamValue.
  const drive = param("Drive", 1500, { min: 0, max: 100 });
  const context = contextWithDevice([drive]);
  await runTool(context, "set_device_parameter", {
    track_index: 0,
    device_index: 0,
    parameter: "drive",
    value: "DEFAULT",
  });
  assert.deepEqual(drive.setCalls, [100]);
});

test("BigInt defaultValue from the Extension Host bridge is normalized", async () => {
  const reso = param("Resonance", 0) as ParamSpy;
  // Real Live 12.4.5 hands back BigInt for some numeric getters.
  (reso as { defaultValue: unknown }).defaultValue = BigInt(700);
  const context = contextWithDevice([reso]);
  await runTool(context, "set_device_parameter", {
    track_index: 0,
    device_index: 0,
    parameter: "0",
    value: "default",
  });
  assert.deepEqual(reso.setCalls, [700]);
});

test("set_device_parameters mixes resets and numeric sets in one call", async () => {
  const freq = param("Frequency", 440);
  const reso = param("Resonance", 50);
  const context = contextWithDevice([freq, reso]);
  const out = (await runTool(context, "set_device_parameters", {
    track_index: 0,
    device_index: 0,
    params: [
      { parameter: "freq", value: "default" },
      { parameter: "reso", value: "120" },
    ],
  })) as { applied: { parameter: string; value: number }[] };
  assert.deepEqual(freq.setCalls, [440]);
  assert.deepEqual(reso.setCalls, [120]);
  assert.equal(out.applied.length, 2);
});

test("get_device_parameters reports each parameter's default", async () => {
  const freq = param("Frequency", 440);
  const context = contextWithDevice([freq]);
  const out = (await runTool(context, "get_device_parameters", {
    track_index: 0,
    device_index: 0,
  })) as { parameters: { name: string; default: number }[] };
  assert.equal(out.parameters[0].default, 440);
});
