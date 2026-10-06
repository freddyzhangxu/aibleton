import assert from "node:assert/strict";
import test from "node:test";

import { toolState, type Ctx } from "../state.js";
import {
  clearCreatedDevices,
  handleIdOf,
  recordCreatedDevice,
  targetIsAgentCreatedDevice,
} from "./created-devices.js";

test("handleIdOf accepts bigint and number handles and tolerates plain objects", () => {
  assert.equal(handleIdOf({ handle: { id: 42n } }), "42");
  assert.equal(handleIdOf({ handle: { id: 7 } }), "7");
  assert.equal(handleIdOf({ name: "No handle" }), undefined);
  assert.equal(handleIdOf(undefined), undefined);
  assert.equal(handleIdOf(null), undefined);
});

test("recordCreatedDevice ignores handle-less fakes", () => {
  try {
    recordCreatedDevice({ name: "Plain fake" });
    assert.equal(toolState.activeCreatedDeviceHandles.size, 0);
  } finally {
    clearCreatedDevices();
  }
});

test("targetIsAgentCreatedDevice returns false for non-device tools without touching the song", () => {
  const context = {
    application: {
      song: {
        get tracks() { throw new Error("must not resolve a target"); },
      },
    },
  } as unknown as Ctx;
  assert.equal(targetIsAgentCreatedDevice(context, "delete_track", { track_index: 0 }), false);
  assert.equal(targetIsAgentCreatedDevice(context, "some_unknown_tool", {}), false);
});

test("targetIsAgentCreatedDevice fails closed when target resolution throws", () => {
  const context = {
    application: { song: { tracks: [], scenes: [] } },
  } as unknown as Ctx;
  // No tracks at all — resolveTrack throws, bypass must return false.
  assert.equal(
    targetIsAgentCreatedDevice(context, "delete_device", { track_index: 0, device_index: 0 }),
    false,
  );
});

test("targetIsAgentCreatedDevice matches only the recorded handle, not the name", () => {
  const userDevice = { name: "Reverb" }; // user's device, never recorded
  const agentDevice = { name: "Reverb", handle: { id: 9n } };
  const context = {
    application: {
      song: { tracks: [{ name: "Bass", devices: [userDevice, agentDevice] }], scenes: [] },
    },
  } as unknown as Ctx;
  try {
    recordCreatedDevice(agentDevice);
    // Name resolution hits the FIRST "Reverb" — the user's — whose handle is
    // not in the registry.
    assert.equal(
      targetIsAgentCreatedDevice(context, "delete_device", { track_index: 0, device_name: "Reverb" }),
      false,
    );
    // Index 1 is the agent's own device.
    assert.equal(
      targetIsAgentCreatedDevice(context, "delete_device", { track_index: 0, device_index: 1 }),
      true,
    );
  } finally {
    clearCreatedDevices();
  }
});
