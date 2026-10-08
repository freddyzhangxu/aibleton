import assert from "node:assert/strict";
import test from "node:test";

import { toolState, type Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

function insertContext() {
  const calls: string[] = [];
  const devices: { name: string }[] = [];
  const track = {
    name: "Bass",
    get devices() { return devices; },
    insertDevice: async (name: string, index: number) => {
      calls.push(`insert:${name}:${index}`);
      const device = { name };
      devices.splice(index, 0, device);
      return device;
    },
  };
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, calls, devices };
}

test("insert_device rejects the legacy random instrument selector", async () => {
  const { context, calls, devices } = insertContext();
  await assert.rejects(
    runTool(context, "insert_device", {
      index: 0,
      track_name: "Bass",
      device_name: "random",
    }),
    /choose a specific Live instrument/i,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(devices, []);
});

test("insert_device preserves an explicitly named instrument", async () => {
  const { context, calls } = insertContext();
  const result = await runTool(context, "insert_device", {
    index: 0,
    track_name: "Bass",
    device_name: "Analog",
  }) as Record<string, unknown>;

  assert.deepEqual(calls, ["insert:Analog:0"]);
  assert.equal(result.inserted, "Analog");
  assert.equal(result.requested, undefined);
  assert.equal(result.selected, undefined);
  assert.equal(toolState.activeDeleteAuthorization, undefined);
});

test("insert_device forwards exact native vocal-device names to the SDK", async () => {
  const deviceNames = [
    "Auto Shift",
    "Gate",
    "Multiband Dynamics",
    "Roar",
    "Glue Compressor",
    "Hybrid Reverb",
    "Vocoder",
  ];

  for (const deviceName of deviceNames) {
    const { context, calls, devices } = insertContext();
    const result = await runTool(context, "insert_device", {
      index: 0,
      track_name: "Bass",
      device_name: deviceName,
    }) as Record<string, unknown>;

    assert.deepEqual(calls, [`insert:${deviceName}:0`]);
    assert.equal(result.inserted, deviceName);
    assert.deepEqual(devices, [{ name: deviceName }]);
  }
});
