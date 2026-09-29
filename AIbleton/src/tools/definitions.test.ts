import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "./definitions.js";

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
