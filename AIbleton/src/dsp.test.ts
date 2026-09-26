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

test("true peak recovers the inter-sample overshoot a sample peak misses", () => {
  // fs/4 sine phased so every sample reads ±√2/2: sample peak −3.01 dBFS,
  // but the reconstructed waveform reaches 0 dBFS between samples.
  const sampleRate = 48000;
  const samples = new Float32Array(sampleRate);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((Math.PI * i) / 2 + Math.PI / 4);
  const features = analyzePcm({ sampleRate, channels: 1, samples, channelData: [samples] });
  assert.ok(Math.abs(features.peakDb - -3.01) < 0.05, `sample peak ${features.peakDb}`);
  assert.ok(Math.abs(features.truePeakDb) < 0.2, `true peak ${features.truePeakDb}`);
});

test("true peak is never below the sample peak", () => {
  const features = analyzePcm(sinePcm(1));
  assert.ok(features.truePeakDb >= features.peakDb - 0.01, `tp ${features.truePeakDb} < peak ${features.peakDb}`);
});

test("short-term LUFS max matches integrated for a steady calibrated sine", () => {
  const features = analyzePcm(sinePcm(4));
  assert.ok(features.shortTermMaxLufs !== undefined && features.integratedLufs !== undefined);
  assert.ok(
    Math.abs(features.shortTermMaxLufs! - features.integratedLufs!) < 0.5,
    `short-term ${features.shortTermMaxLufs} vs integrated ${features.integratedLufs}`,
  );
});

test("short-term LUFS range captures a quiet-to-loud jump", () => {
  // 4 s at amp 0.05 then 4 s at amp 0.5 (20 dB step, 1 kHz).
  const sampleRate = 48000;
  const n = sampleRate * 8;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = (i < n / 2 ? 0.05 : 0.5) * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  const features = analyzePcm({ sampleRate, channels: 1, samples, channelData: [samples] });
  assert.ok(features.shortTermRangeLu !== undefined && features.shortTermMaxLufs !== undefined);
  assert.ok(features.shortTermRangeLu! > 15 && features.shortTermRangeLu! < 21, `range ${features.shortTermRangeLu}`);
  assert.ok(Math.abs(features.shortTermMaxLufs! - -9) < 1, `max ${features.shortTermMaxLufs}`);
});

test("short-term LUFS is undefined below one 3 s window or in silence", () => {
  assert.equal(analyzePcm(sinePcm(2.5)).shortTermMaxLufs, undefined);
  const silence = { ...sinePcm(4), samples: new Float32Array(48000 * 4), channelData: [new Float32Array(48000 * 4)] };
  assert.equal(analyzePcm(silence).shortTermMaxLufs, undefined);
});

function stereoPcm(seconds: number, mkLeft: (i: number, fs: number) => number, mkRight: (i: number, fs: number) => number) {
  const sampleRate = 48000;
  const n = Math.floor(sampleRate * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = mkLeft(i, sampleRate);
    right[i] = mkRight(i, sampleRate);
    samples[i] = (left[i] + right[i]) / 2;
  }
  return { sampleRate, channels: 2, samples, channelData: [left, right] };
}

const sineAt = (freq: number, amp = 0.1) => (i: number, fs: number) => amp * Math.sin((2 * Math.PI * freq * i) / fs);

test("stereo correlation is +1 for identical channels, −1 for inverted, ~0 for decorrelated", () => {
  const sine = sineAt(1000);
  const inverted = analyzePcm(stereoPcm(1, sine, (i, fs) => -sine(i, fs)));
  const identical = analyzePcm(stereoPcm(1, sine, sine));
  const decorrelated = analyzePcm(stereoPcm(1, sineAt(1000), sineAt(1737)));
  assert.ok(Math.abs(identical.correlation! - 1) < 1e-3, `got ${identical.correlation}`);
  assert.ok(Math.abs(inverted.correlation! + 1) < 1e-3, `got ${inverted.correlation}`);
  assert.ok(Math.abs(decorrelated.correlation!) < 0.05, `got ${decorrelated.correlation}`);
});

test("correlation is undefined for mono sources", () => {
  assert.equal(analyzePcm(sinePcm(1)).correlation, undefined);
  assert.equal(analyzePcm(sinePcm(1)).lowCorrelation, undefined);
});

test("low-band correlation is suppressed when the <150 Hz band is empty", () => {
  // Two decorrelated high sines, no low content: corrLow would be a
  // noise-floor estimate and must be withheld; overall corr still reports.
  const features = analyzePcm(stereoPcm(1, sineAt(5000), sineAt(7351)));
  assert.equal(features.lowCorrelation, undefined);
  assert.ok(features.correlation !== undefined);
});

test("low-band correlation survives anti-phase lows that cancel in the mono mix", () => {
  // 80 Hz fully anti-phase + in-phase 3 kHz: the low end vanishes from the
  // mono mix (bands read ~0) but corrLow must still report −1.
  const low = sineAt(80, 0.1);
  const high = sineAt(3000, 0.2);
  const features = analyzePcm(stereoPcm(1, (i, fs) => low(i, fs) + high(i, fs), (i, fs) => -low(i, fs) + high(i, fs)));
  assert.ok(Math.abs(features.lowCorrelation! + 1) < 0.02, `got ${features.lowCorrelation}`);
});

test("low-band correlation isolates the <150 Hz band", () => {
  // In-phase 80 Hz + out-of-phase 5 kHz: overall correlation drops, low stays +1.
  const low = sineAt(80);
  const high = sineAt(5000);
  const features = analyzePcm(stereoPcm(1, (i, fs) => low(i, fs) + high(i, fs), (i, fs) => low(i, fs) - high(i, fs)));
  assert.ok(Math.abs(features.lowCorrelation! - 1) < 0.02, `got ${features.lowCorrelation}`);
  assert.ok(Math.abs(features.correlation!) < 0.05, `got ${features.correlation}`);
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
