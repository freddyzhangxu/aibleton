import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { featuresFromBuffer } from "./dsp.js";

function fixture(name: string) {
  const file = fileURLToPath(new URL(`./__fixtures__/audio/${name}`, import.meta.url));
  return readFileSync(file);
}

async function assertAnalyzable(name: string, ext: string) {
  const result = await featuresFromBuffer(`${name}.${ext}`, fixture(`${name}.${ext}`));
  assert.ok("features" in result, "decoder should return audio features");
  assert.ok(result.features.durationSec > 0.2 && result.features.durationSec < 0.4);
  assert.ok(result.features.rmsDb > -50);
  assert.ok(result.features.sampleRate > 0);
}

test("decodes OGG Vorbis audio", async () => {
  await assertAnalyzable("sine-vorbis", "ogg");
});

test("decodes AAC audio in an M4A container", async () => {
  await assertAnalyzable("sine-aac", "m4a");
});

test("decodes ALAC audio in an M4A container", async () => {
  await assertAnalyzable("sine-alac", "m4a");
});

test("applies the analysis duration cap to OGG Vorbis", async () => {
  const result = await featuresFromBuffer("sine-vorbis.ogg", fixture("sine-vorbis.ogg"), { maxSeconds: 0.1 });
  assert.ok("features" in result, "decoder should return audio features");
  assert.equal(result.features.partial, true);
  assert.ok(result.features.durationSec <= 0.1);
});
