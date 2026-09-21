import assert from "node:assert/strict";
import test from "node:test";

import { deleteAuthorizationFor } from "../chat/deleteauth.js";
import { toolState, type Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

type FakeDevice = { name: string };

function replacementContext(options: { failInsert?: boolean } = {}) {
  const calls: string[] = [];
  const devices: FakeDevice[] = [{ name: "Operator" }, { name: "Auto Filter" }];
  const track = {
    name: "Lead",
    get devices() { return devices; },
    insertDevice: async (name: string, index: number) => {
      calls.push(`insert:${name}:${index}`);
      if (options.failInsert) throw new Error("host rejected device");
      const device = { name };
      devices.splice(index, 0, device);
      return device;
    },
    deleteDevice: async (device: FakeDevice) => {
      calls.push(`delete:${device.name}`);
      const index = devices.indexOf(device);
      if (index < 0) throw new Error("device no longer exists");
      devices.splice(index, 1);
    },
  };
  const context = {
    application: { song: { tracks: [track], scenes: [] } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, calls, devices };
}

function replacementInput(extra: Record<string, unknown> = {}) {
  return {
    track_index: 0,
    track_name: "Lead",
    source_device_name: "Operator",
    replacement_device_name: "Analog",
    ...extra,
  };
}

async function withDeviceReplacementAuthorization<T>(fn: () => Promise<T>): Promise<T> {
  toolState.activeDeleteAuthorization = deleteAuthorizationFor("Replace the Operator instrument on Lead with Analog.");
  try {
    return await fn();
  } finally {
    toolState.activeDeleteAuthorization = undefined;
  }
}

test("replace_device deletes the source before inserting the replacement at its index", async () => {
  const { context, calls, devices } = replacementContext();
  const result = await withDeviceReplacementAuthorization(() =>
    runTool(context, "replace_device", replacementInput()),
  ) as Record<string, unknown>;

  assert.deepEqual(calls, ["delete:Operator", "insert:Analog:0"]);
  assert.deepEqual(devices.map((device) => device.name), ["Analog", "Auto Filter"]);
  assert.equal(result.replaced, "Operator");
  assert.equal(result.replacement, "Analog");
  assert.equal(result.verified, true);
  assert.equal(result.mode, "delete_first");
});

test("replace_device reports Undo recovery when insertion fails after deleting the source", async () => {
  const { context, calls, devices } = replacementContext({ failInsert: true });
  const result = await withDeviceReplacementAuthorization(() =>
    runTool(context, "replace_device", replacementInput()),
  ) as Record<string, unknown>;

  assert.deepEqual(calls, ["delete:Operator", "insert:Analog:0"]);
  assert.deepEqual(devices.map((device) => device.name), ["Auto Filter"]);
  assert.equal(result.replacement_not_applied, true);
  assert.equal(result.source_deleted, true);
  assert.equal(result.mode, "delete_first");
  assert.match(String(result.undo), /Undo/);
});

test("replace_device is refused without explicit device-replacement authorization", async () => {
  const { context, calls, devices } = replacementContext();
  toolState.activeDeleteAuthorization = undefined;
  const result = await runTool(context, "replace_device", replacementInput()) as Record<string, unknown>;

  assert.equal(result.delete_authorization_required, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(devices.map((device) => device.name), ["Operator", "Auto Filter"]);
});
