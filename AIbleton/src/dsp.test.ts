import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzePcm, featuresFromBuffer } from "./dsp.js";

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
  assert.equal(result.features.integratedLufs, undefined);
  assert.ok(result.features.durationSec <= 0.1);
});

function sinePcm(seconds: number, amplitude = 0.1) {
  const sampleRate = 48000;
  const samples = new Float32Array(Math.floor(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  return { sampleRate, channels: 1, samples, channelData: [samples] };
}

test("integrated LUFS matches a -23 LUFS calibrated 1 kHz sine", () => {
  const features = analyzePcm(sinePcm(3));
  assert.ok(features.integratedLufs !== undefined);
  assert.ok(Math.abs(features.integratedLufs! - -23) < 0.2, `got ${features.integratedLufs}`);
});

test("integrated LUFS uses channel weighting for stereo", () => {
  const mono = analyzePcm(sinePcm(3));
  const stereoPcm = sinePcm(3);
  const stereo = analyzePcm({ ...stereoPcm, channels: 2, channelData: [stereoPcm.samples, stereoPcm.samples] });
  assert.ok(mono.integratedLufs !== undefined && stereo.integratedLufs !== undefined);
  assert.ok(Math.abs((stereo.integratedLufs! - mono.integratedLufs!) - 3.01) < 0.05);
});

test("integrated LUFS is unavailable for silence or audio shorter than a gating block", () => {
  const silence = analyzePcm({ ...sinePcm(3), samples: new Float32Array(48000 * 3), channelData: [new Float32Array(48000 * 3)] });
  const short = analyzePcm(sinePcm(0.25));
  assert.equal(silence.integratedLufs, undefined);
  assert.equal(short.integratedLufs, undefined);
});

function stereoSineWav(): Buffer {
  const sampleRate = 48000;
  const frames = sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(0.1 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 32767);
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("featuresFromBuffer reports calibrated stereo Integrated LUFS", async () => {
  const result = await featuresFromBuffer("stereo-reference.wav", stereoSineWav());
  assert.ok("features" in result);
  assert.ok(result.features.integratedLufs !== undefined);
  assert.ok(Math.abs(result.features.integratedLufs! - -20) < 0.2, `got ${result.features.integratedLufs}`);
});
