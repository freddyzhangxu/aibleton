import assert from "node:assert/strict";
import test from "node:test";
import { Device, Simpler } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

function simpler(name: string, filePath: string | null): Simpler<"1.0.0"> {
  const device = Object.create(Simpler.prototype) as Simpler<"1.0.0">;
  Object.defineProperties(device, {
    name: { value: name, configurable: true },
    sample: { value: filePath ? { filePath } : null, configurable: true },
  });
  return device;
}

function context(devices: Device<"1.0.0">[]): Ctx {
  return {
    application: { song: { tracks: [{ name: "Bass", devices }], scenes: [] } },
  } as unknown as Ctx;
}

test("get_simpler_sample returns the first Simpler when no device selector is supplied", async () => {
  const result = await runTool(context([simpler("Bass One-shot", "/Project/Samples/bass.wav")]), "get_simpler_sample", { track_index: 0 });
  assert.deepEqual(result, {
    device: "Bass One-shot", device_index: 0, loaded: true,
    file: "/Project/Samples/bass.wav", file_name: "bass.wav", track_index: 0,
  });
});

test("get_simpler_sample reports an unloaded Simpler without mutating it", async () => {
  const result = await runTool(context([simpler("Empty Simpler", null)]), "get_simpler_sample", { track_index: 0, device_index: 0 });
  assert.deepEqual(result, { device: "Empty Simpler", device_index: 0, loaded: false, track_index: 0 });
});

test("get_simpler_sample rejects a selected non-Simpler device", async () => {
  const device = Object.create(Device.prototype) as Device<"1.0.0">;
  Object.defineProperty(device, "name", { value: "EQ Eight", configurable: true });
  await assert.rejects(
    () => runTool(context([device]), "get_simpler_sample", { track_index: 0, device_index: 0 }),
    /不是 Simpler/,
  );
});
