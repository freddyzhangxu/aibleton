import assert from "node:assert/strict";
import test from "node:test";
import { Device, DrumRack, Simpler } from "@ableton-extensions/sdk";
import type { Ctx } from "../state.js";
import { runTool } from "./dispatcher.js";

function simpler(name: string, filePath: string | null, onReplace?: (path: string) => void): Simpler<"1.0.0"> {
  const device = Object.create(Simpler.prototype) as Simpler<"1.0.0">;
  Object.defineProperties(device, {
    name: { value: name, configurable: true },
    sample: { value: filePath ? { filePath } : null, configurable: true },
    replaceSample: { value: async (path: string) => { onReplace?.(path); return { filePath: path }; }, configurable: true },
  });
  return device;
}

function fixture(devices: Device<"1.0.0">[], options?: { inserted?: Simpler<"1.0.0">; onImport?: (path: string) => void }) {
  const chain = {
    receivingNote: 38,
    devices,
    insertDevice: async (name: string, index: number) => {
      assert.equal(name, "Simpler");
      assert.equal(index, 0);
      assert.ok(options?.inserted);
      return options!.inserted!;
    },
  };
  const rack = Object.create(DrumRack.prototype) as DrumRack<"1.0.0">;
  Object.defineProperties(rack, {
    name: { value: "Kit", configurable: true },
    chains: { value: [chain], configurable: true },
  });
  const context = {
    application: { song: { tracks: [{ name: "Drums", devices: [rack] }], scenes: [] } },
    resources: { importIntoProject: async (path: string) => { options?.onImport?.(path); return "/Project/Managed/snare.wav"; } },
    withinTransaction: <T>(fn: () => T) => fn(),
  } as unknown as Ctx;
  return { context, chain };
}

test("get_drum_pad_sample lists loaded and unloaded Simplers on a pad", async () => {
  const loaded = simpler("Snare", "/Library/snare.wav");
  const unloaded = simpler("Layer", null);
  const { context } = fixture([loaded, unloaded]);
  const result = await runTool(context, "get_drum_pad_sample", { track_index: 0, pad_note: 38 });
  assert.deepEqual(result, {
    rack: "Kit", pad_note: 38,
    simplers: [
      { device: "Snare", device_index: 0, loaded: true, file: "/Library/snare.wav", file_name: "snare.wav" },
      { device: "Layer", device_index: 1, loaded: false },
    ],
    track_index: 0,
  });
});

test("replace_drum_pad_sample imports into the project and targets a named Simpler", async () => {
  const replacements: string[] = [];
  const target = simpler("Snare", "/Library/old.wav", (path) => replacements.push(path));
  const imported: string[] = [];
  const { context } = fixture([target], { onImport: (path) => imported.push(path) });
  const result = await runTool(context, "replace_drum_pad_sample", {
    track_index: 0, pad_note: 38, device_name: "Snare", file_path: process.execPath,
  });
  assert.deepEqual(imported, [process.execPath]);
  assert.deepEqual(replacements, ["/Project/Managed/snare.wav"]);
  assert.deepEqual(result, {
    rack: "Kit", pad_note: 38, device: "Snare", device_index: 0,
    file: "/Project/Managed/snare.wav", file_name: "snare.wav", inserted_simpler: false, track_index: 0,
  });
});

test("replace_drum_pad_sample inserts a Simpler for an empty pad", async () => {
  const replacements: string[] = [];
  const inserted = simpler("Simpler", null, (path) => replacements.push(path));
  const { context } = fixture([], { inserted });
  const result = await runTool(context, "replace_drum_pad_sample", {
    track_index: 0, pad_note: 38, file_path: process.execPath,
  });
  assert.deepEqual(replacements, ["/Project/Managed/snare.wav"]);
  assert.deepEqual(result, {
    rack: "Kit", pad_note: 38, device: "Simpler", device_index: 0,
    file: "/Project/Managed/snare.wav", file_name: "snare.wav", inserted_simpler: true, track_index: 0,
  });
});

test("replace_drum_pad_sample refuses a selected non-Simpler without inserting", async () => {
  const effect = Object.create(Device.prototype) as Device<"1.0.0">;
  Object.defineProperty(effect, "name", { value: "EQ Eight", configurable: true });
  const inserted = simpler("Simpler", null);
  const { context } = fixture([effect], { inserted });
  await assert.rejects(
    () => runTool(context, "replace_drum_pad_sample", {
      track_index: 0, pad_note: 38, device_index: 0, file_path: process.execPath,
    }),
    /不是 Simpler/,
  );
});
