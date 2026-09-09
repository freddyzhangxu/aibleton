/**
 * Fixture-based smoke test for src/dsp.ts (audio feature extraction).
 * Run: npx tsx scripts/test-audio.ts
 *
 * All fixtures are WAV/AIFF buffers synthesized in memory — no filesystem,
 * no Live. Covers decode edge cases (24-bit sign extension, AIFF 80-bit
 * sample rate, odd chunk padding, NaN floats) and feature sanity (band
 * fractions, centroid, transient density, dynamic range).
 */
import {
  analyzePcm,
  decodeAiff,
  decodeAudioBuffer,
  decodeWav,
  featuresFromBuffer,
  type AudioFeatures,
} from "../src/dsp.js";

let failed = 0;
let passed = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (cond) passed++;
  else failed++;
}

// ---------------------------------------------------------------------------
// Buffer synthesis
// ---------------------------------------------------------------------------

function sine(freq: number, amp: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function noise(seconds: number, sr = 44100, seed = 12345): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG
    out[i] = (s / 0x100000000) * 2 - 1;
  }
  return out;
}

function clickTrain(clicksPerSec: number, seconds: number, sr = 44100): Float32Array {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  for (let t = 0.1; t < seconds - 0.05; t += 1 / clicksPerSec) {
    out[Math.floor(t * sr)] = 1;
  }
  return out;
}

function wavPcm(samples: Float32Array, bits: 16 | 24, sampleRate = 44100, oddFiller = false): Buffer {
  const bytesPerSample = bits / 8;
  const dataLen = samples.length * bytesPerSample;
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * bytesPerSample, 16);
  fmt.writeUInt16LE(bytesPerSample, 20);
  fmt.writeUInt16LE(bits, 22);
  const parts: Buffer[] = [fmt];
  if (oddFiller) {
    const junk = Buffer.alloc(8 + 3 + 1); // odd size 3 + pad byte
    junk.write("JUNK", 0, "ascii");
    junk.writeUInt32LE(3, 4);
    junk.write("abc", 8, "ascii");
    parts.push(junk);
  }
  const data = Buffer.alloc(8 + dataLen);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(dataLen, 4);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const o = 8 + i * bytesPerSample;
    if (bits === 16) {
      data.writeInt16LE(Math.round(s * 32767), o);
    } else {
      let x = Math.round(s * 8388607);
      if (x < 0) x += 0x1000000;
      data[o] = x & 0xff;
      data[o + 1] = (x >> 8) & 0xff;
      data[o + 2] = (x >> 16) & 0xff;
    }
  }
  parts.push(data);
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

function wavFloat(samples: Float32Array, sampleRate = 44100): Buffer {
  const dataLen = samples.length * 4;
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(3, 8); // IEEE float
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(32, 22);
  const data = Buffer.alloc(8 + dataLen);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(dataLen, 4);
  for (let i = 0; i < samples.length; i++) data.writeFloatLE(samples[i], 8 + i * 4);
  const body = Buffer.concat([fmt, data]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

/** 80-bit IEEE-754 extended float (AIFF sample rate). */
function writeExtended80(rate: number): Buffer {
  const buf = Buffer.alloc(10);
  const exp = Math.floor(Math.log2(rate));
  const f = rate / 2 ** exp; // [1, 2)
  const hi = Math.floor(f * 2 ** 31);
  const lo = Math.round((f * 2 ** 31 - hi) * 2 ** 32);
  buf.writeUInt16BE(16383 + exp, 0);
  buf.writeUInt32BE(hi >>> 0, 2);
  buf.writeUInt32BE(lo >>> 0, 6);
  return buf;
}

function aiffPcm(samples: Float32Array, bits: 16 | 24, sampleRate = 44100): Buffer {
  const bytesPerSample = bits / 8;
  const dataLen = samples.length * bytesPerSample;
  const comm = Buffer.alloc(8 + 18);
  comm.write("COMM", 0, "ascii");
  comm.writeUInt32BE(18, 4);
  comm.writeInt16BE(1, 8); // mono
  comm.writeUInt32BE(samples.length, 10);
  comm.writeInt16BE(bits, 14);
  writeExtended80(sampleRate).copy(comm, 16);
  const ssnd = Buffer.alloc(8 + 8 + dataLen);
  ssnd.write("SSND", 0, "ascii");
  ssnd.writeUInt32BE(8 + dataLen, 4);
  ssnd.writeUInt32BE(0, 8); // offset
  ssnd.writeUInt32BE(0, 12); // blockSize
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const o = 16 + i * bytesPerSample;
    if (bits === 16) {
      ssnd.writeInt16BE(Math.round(s * 32767), o);
    } else {
      let x = Math.round(s * 8388607);
      if (x < 0) x += 0x1000000;
      ssnd[o] = (x >> 16) & 0xff;
      ssnd[o + 1] = (x >> 8) & 0xff;
      ssnd[o + 2] = x & 0xff;
    }
  }
  const body = Buffer.concat([comm, ssnd]);
  const head = Buffer.alloc(12);
  head.write("FORM", 0, "ascii");
  head.writeUInt32BE(4 + body.length, 4);
  head.write("AIFF", 8, "ascii");
  return Buffer.concat([head, body]);
}

function pcmOf(outcome: ReturnType<typeof decodeWav>): Float32Array {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.pcm.samples;
}

function featsOf(outcome: ReturnType<typeof featuresFromBuffer>): AudioFeatures {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.features;
}

const allFinite = (f: AudioFeatures): boolean =>
  [f.rmsDb, f.peakDb, f.crestDb, f.loudnessDb, f.spectralCentroidHz, ...Object.values(f.bands)].every(
    Number.isFinite,
  );

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

console.log("\nWAV decode — 16/24/32f round-trip");
const src = sine(440, 0.5, 1);
const EXPECT_RMS_DB = 20 * Math.log10(0.5 / Math.SQRT2); // ≈ −9.03
const f16 = featsOf(featuresFromBuffer("a.wav", wavPcm(src, 16)));
const f24 = featsOf(featuresFromBuffer("a.wav", wavPcm(src, 24)));
const f32 = featsOf(featuresFromBuffer("a.wav", wavFloat(src)));
check("16-bit rmsDb ≈ theoretical", Math.abs(f16.rmsDb - EXPECT_RMS_DB) < 0.3, `got ${f16.rmsDb.toFixed(2)}`);
check("24-bit within 0.2 dB of 16-bit", Math.abs(f24.rmsDb - f16.rmsDb) < 0.2, `got ${f24.rmsDb.toFixed(2)}`);
check("32-float within 0.2 dB of 16-bit", Math.abs(f32.rmsDb - f16.rmsDb) < 0.2, `got ${f32.rmsDb.toFixed(2)}`);
check("sampleRate + channels survive", f16.sampleRate === 44100 && f16.channels === 1);

console.log("\nWAV decode — edge cases");
const neg = pcmOf(decodeWav(wavPcm(new Float32Array([-1, 1]), 24)));
check("24-bit sign extension: −1.0 decodes", Math.abs(neg[0] + 1) < 0.001 && Math.abs(neg[1] - 1) < 0.001, `got ${neg[0]}`);
const fOdd = featsOf(featuresFromBuffer("a.wav", wavPcm(src, 16, 44100, true)));
check("odd-sized chunk pad byte tolerated", Math.abs(fOdd.rmsDb - f16.rmsDb) < 0.2);
check("non-RIFF rejected", "error" in decodeWav(Buffer.from("NOPE-NOPE-NOPE-NOPE")));
const hot = featsOf(featuresFromBuffer("a.wav", wavFloat(sine(440, 2.0, 0.5))));
check("hot float: peakDb > 0, no clamping", hot.peakDb > 0, `got ${hot.peakDb.toFixed(2)}`);
const nanSrc = sine(440, 0.5, 0.5);
nanSrc[100] = NaN;
nanSrc[200] = Infinity;
nanSrc[300] = -Infinity;
const fNan = featsOf(featuresFromBuffer("a.wav", wavFloat(nanSrc)));
check("NaN/±Inf float sanitized — all features finite", allFinite(fNan));

console.log("\nAIFF decode");
const aSrc = sine(440, 0.5, 1);
const a16 = featsOf(featuresFromBuffer("a.aif", aiffPcm(aSrc, 16)));
check("AIFF 80-bit sample rate → 44100", a16.sampleRate === 44100, `got ${a16.sampleRate}`);
check("AIFF 16-bit rmsDb matches WAV twin", Math.abs(a16.rmsDb - f16.rmsDb) < 0.2, `got ${a16.rmsDb.toFixed(2)}`);
const a24 = featsOf(featuresFromBuffer("a.aif", aiffPcm(aSrc, 24)));
check("AIFF 24-bit rmsDb matches WAV twin", Math.abs(a24.rmsDb - f16.rmsDb) < 0.2, `got ${a24.rmsDb.toFixed(2)}`);
const aNeg = decodeAiff(aiffPcm(new Float32Array([-1]), 24));
check("AIFF 24-bit BE sign extension", !("error" in aNeg) && Math.abs(aNeg.pcm.samples[0] + 1) < 0.001);

console.log("\nFormat dispatch");
const mp3 = featuresFromBuffer("loop.mp3", Buffer.from("garbage-garbage"));
check("mp3 → unsupported-format error", "error" in mp3 && mp3.error.includes("unsupported format"), "error" in mp3 ? mp3.error : "");
const xyz = featuresFromBuffer("loop.xyz", Buffer.from("garbage"));
check("unknown extension → error", "error" in xyz && xyz.error.includes("unknown audio extension"));
check("decodeAudioBuffer never throws on garbage wav", "error" in decodeAudioBuffer("x.wav", Buffer.from("garbage")));

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

console.log("\nFeatures — silence");
const sil = featsOf(featuresFromBuffer("s.wav", wavPcm(new Float32Array(44100), 16)));
check("silence: all finite", allFinite(sil));
check("silence: rmsDb at −100 floor", sil.rmsDb <= -99, `got ${sil.rmsDb.toFixed(1)}`);
check("silence: crest 0, centroid 0", sil.crestDb === 0 && sil.spectralCentroidHz === 0);
check("silence: all bands 0", Object.values(sil.bands).every((b) => b === 0));

console.log("\nFeatures — spectral");
// 43.07 Hz = FFT bin 2 at 44.1k/2048 → lands squarely in `sub`.
const low = featsOf(featuresFromBuffer("l.wav", wavFloat(sine(43.0664, 0.8, 1))));
check("43 Hz sine → sub-dominant bands", low.bands.sub > 0.7, `sub=${low.bands.sub.toFixed(3)}`);
check("43 Hz sine → low centroid", low.spectralCentroidHz < 200, `got ${low.spectralCentroidHz.toFixed(0)}`);
check("band fractions sum ≈ 1", Math.abs(Object.values(low.bands).reduce((a, b) => a + b, 0) - 1) < 0.01);
const nz = featsOf(featuresFromBuffer("n.wav", wavFloat(noise(2))));
check("white noise centroid in 6-16 kHz", nz.spectralCentroidHz > 6000 && nz.spectralCentroidHz < 16000, `got ${nz.spectralCentroidHz.toFixed(0)}`);
check("white noise: high band dominates", nz.bands.high > 0.6, `high=${nz.bands.high.toFixed(3)}`);
check("white noise: sub ≈ 0", nz.bands.sub < 0.02, `sub=${nz.bands.sub.toFixed(4)}`);
const direct = analyzePcm({ sampleRate: 44100, channels: 1, samples: sine(10000, 0.5, 0.5) });
check("analyzePcm direct: 10 kHz centroid", Math.abs(direct.spectralCentroidHz - 10000) < 500, `got ${direct.spectralCentroidHz.toFixed(0)}`);

console.log("\nFeatures — dynamics & transients");
const loud = sine(440, 0.9, 1);
const quiet = sine(440, 0.05, 1);
const combo = new Float32Array(loud.length + quiet.length);
combo.set(loud, 0);
combo.set(quiet, loud.length);
const dyn = featsOf(featuresFromBuffer("d.wav", wavFloat(combo)));
check("loud→quiet: dynamicRangeDb > 10", dyn.dynamicRangeDb !== undefined && dyn.dynamicRangeDb > 10, `got ${dyn.dynamicRangeDb?.toFixed(1)}`);
const steady = featsOf(featuresFromBuffer("s.wav", wavFloat(sine(440, 0.5, 2))));
check("steady sine: dynamicRangeDb < 3", steady.dynamicRangeDb !== undefined && steady.dynamicRangeDb < 3, `got ${steady.dynamicRangeDb?.toFixed(1)}`);
const clicks = featsOf(featuresFromBuffer("c.wav", wavFloat(clickTrain(4, 2))));
check(
  "4 Hz click train → transientDensity ≈ 4",
  clicks.transientDensity !== undefined && clicks.transientDensity > 2.5 && clicks.transientDensity < 5.5,
  `got ${clicks.transientDensity?.toFixed(2)}`,
);
check("click train: high crest", clicks.crestDb > 6, `got ${clicks.crestDb.toFixed(1)}`);

console.log("\nFeatures — short & truncated");
const short = featsOf(featuresFromBuffer("t.wav", wavFloat(sine(440, 0.5, 0.15))));
check("0.15 s: dynamicRangeDb undefined (< 8 frames)", short.dynamicRangeDb === undefined);
check("0.15 s: transientDensity undefined (< 0.5 s)", short.transientDensity === undefined);
const trunc = featsOf(featuresFromBuffer("t.wav", wavFloat(sine(440, 0.5, 2)), { maxSeconds: 1 }));
check("maxSeconds truncates → partial flag", trunc.partial === true);
check("maxSeconds truncates → durationSec ≈ 1", Math.abs(trunc.durationSec - 1) < 0.01, `got ${trunc.durationSec.toFixed(3)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
