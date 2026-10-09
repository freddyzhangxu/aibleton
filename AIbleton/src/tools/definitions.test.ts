import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, activeTools } from "./definitions.js";

test("describes generic insertion attempts for named built-in Live vocal devices", () => {
  const insertDevice = TOOLS.find((tool) => tool.name === "insert_device");
  assert.ok(insertDevice);

  const description = insertDevice.description;
  assert.match(description, /passes the exact device_name to Live/i);
  assert.match(description, /no device-name allowlist/i);
  assert.match(description, /have not been individually verified/i);
  assert.match(description, /If Live rejects the name or device, report that error/i);
  assert.match(description, /third-party plugins are not supported/i);

  for (const device of [
    "Auto Shift",
    "Gate",
    "Multiband Dynamics",
    "Roar",
    "Glue Compressor",
    "Hybrid Reverb",
    "Vocoder",
  ]) {
    assert.ok(description.includes(device), `missing device name: ${device}`);
  }
});

test("keeps executable plan mode optional and documents its argument contract", () => {
  const plan = TOOLS.find((tool) => tool.name === "set_plan");
  assert.ok(plan);
  const schema = plan.input_schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(schema.required, ["steps"]);
  const execute = schema.properties.execute as { type: string; description: string };
  assert.equal(execute.type, "boolean");
  assert.match(execute.description, /fully specified multi-step task/);
  assert.match(execute.description, /execute every validated Set-edit step in this same call/);
  assert.match(plan.description, /sequentially inside this set_plan call/);
  assert.match(plan.description, /fully specified multi-step task, you MUST include execute: true/);
  assert.match(plan.description, /Execution stops on the first failed step/);
  assert.match(plan.description, /do not reissue completed steps/);

  const stepSchema = (schema.properties.steps as { items: { properties: Record<string, unknown> } }).items;
  const args = stepSchema.properties.args as { description: string };
  assert.match(args.description, /\$ref/);
  assert.match(args.description, /execute is true/);
  assert.ok(stepSchema.properties.expectedEffects);
});

test("documents actual creation result fields so later plan steps can reference them", () => {
  const createMidi = TOOLS.find((tool) => tool.name === "create_midi_track");
  assert.ok(createMidi);
  assert.match(createMidi.description, /result returns the actual track name in `created`/);
  assert.match(createMidi.description, /step-id#\/created/);
});

test("describes Piano as a specific instrument within the broader Keys family", () => {
  const recipeTool = TOOLS.find((tool) => tool.name === "apply_sound_recipe");
  assert.ok(recipeTool);
  assert.match(recipeTool.description, /Piano is a specific instrument within the Keys family/);
  assert.match(recipeTool.description, /Generic Keys does not default to piano samples/);
  assert.match(recipeTool.description, /explicit Piano request or a genre profile that names Piano/);
  assert.doesNotMatch(recipeTool.description, /Generic Keys defaults to keys_piano_sample/);
  assert.match(recipeTool.description, /Use the genre profile in system instructions to select supported recipes for an already selected role/);
});

test("keeps genre profiles from constraining which roles are created", () => {
  const recipeTool = TOOLS.find((tool) => tool.name === "apply_sound_recipe");
  assert.ok(recipeTool);
  assert.match(recipeTool.description, /profiles map sounds and never choose which roles to create/);
  assert.doesNotMatch(recipeTool.description, /core\/optional parts/i);
});

test("simple edits advertise their reads and writes without the full tool catalog", () => {
  assert.deepEqual(activeTools("tempo").map((tool) => tool.name).sort(), ["get_song_overview", "set_tempo"]);
  const mixer = activeTools("mixer").map((tool) => tool.name);
  for (const name of ["get_song_overview", "get_track_mixer", "set_track_mixer", "get_return_track_mixer", "set_return_track_mixer"]) assert.ok(mixer.includes(name));
  assert.ok(mixer.length < 10);
  assert.ok(activeTools().length > 60, "ambiguous and creative tasks keep the full catalog");
});
