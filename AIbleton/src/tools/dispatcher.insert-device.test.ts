import assert from "node:assert/strict";
import test from "node:test";

import { toolState, type Ctx } from "../state.js";
import { RANDOM_MELODIC_INSTRUMENTS } from "./instruments.js";
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

test("insert_device resolves random to a concrete melodic instrument", async () => {
  const { context, calls, devices } = insertContext();
  const result = await runTool(context, "insert_device", {
    index: 0,
    track_name: "Bass",
    device_name: "random",
  }) as Record<string, unknown>;

  const selected = String(result.selected);
  assert.ok(RANDOM_MELODIC_INSTRUMENTS.includes(selected as (typeof RANDOM_MELODIC_INSTRUMENTS)[number]));
  assert.deepEqual(calls, [`insert:${selected}:0`]);
  assert.equal(result.requested, "random");
  assert.equal(result.inserted, selected);
  assert.deepEqual(devices, [{ name: selected }]);
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
