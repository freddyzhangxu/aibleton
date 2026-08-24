/**
 * Fixture-based smoke test for src/fileparsers.ts.
 * Run: npx tsx scripts/test-fileparsers.ts
 */
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { parseMidi, summarizeAls, describeBinaryAttachment } from "../src/fileparsers.js";

// ---- build a format-1 SMF: conductor track + one bass track (C-major scale) ----

const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  n >>= 7;
  while (n) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
};
const meta = (type: number, data: number[]) => [0xff, type, data.length, ...data];
const strBytes = (s: string) => [...Buffer.from(s, "latin1")];

const TPQ = 480;
const track0 = [
  ...vlq(0), ...meta(0x03, strBytes("Conductor")),
  ...vlq(0), ...meta(0x51, [0x07, 0xa1, 0x20]),       // 500000 µs/qn = 120 BPM
  ...vlq(0), ...meta(0x58, [4, 2, 24, 8]),            // 4/4
  ...vlq(0), ...meta(0x59, [0, 0]),                   // C major
  ...vlq(0), ...meta(0x2f, []),
];
const scale = [48, 50, 52, 53, 55, 57, 59, 60]; // C3–C4
const track1: number[] = [
  ...vlq(0), ...meta(0x03, strBytes("Bass")),
  ...vlq(0), 0xc0, 33,                                 // program 33 = finger bass
];
for (const p of scale) {
  track1.push(...vlq(0), 0x90, p, 100);
  track1.push(...vlq(TPQ), 0x80, p, 0);                // 1 beat each
}
// CC sweep + running status exercise
track1.push(...vlq(0), 0xb0, 7, 100, ...vlq(10), 7, 90);
track1.push(...vlq(0), ...meta(0x2f, []));

const mtrk = (evs: number[]) => [...strBytes("MTrk"), ...u32be(evs.length), ...evs];
function u32be(n: number) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16be(n: number) { return [(n >>> 8) & 255, n & 255]; }

const smf = Buffer.from([
  ...strBytes("MThd"), ...u32be(6), ...u16be(1), ...u16be(2), ...u16be(TPQ),
  ...mtrk(track0), ...mtrk(track1),
]);

// ---- build a fake .als (gzipped XML mimicking Live 12 structure) ----

const alsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="12" MinorVersion="1.5" Creator="Ableton Live 12.1.5">
  <LiveSet>
    <Tempo><Manual Value="128.5" /></Tempo>
    <TimeSignatures>
      <RemoteableTimeSignature Id="0"><Numerator Value="3" /><Denominator Value="4" /></RemoteableTimeSignature>
    </TimeSignatures>
    <Tracks>
      <GroupTrack Id="9">
        <Name><EffectiveName Value="Drums Bus" /></Name>
        <DeviceChain><Devices><GlueCompressor /></Devices></DeviceChain>
      </GroupTrack>
      <MidiTrack Id="10">
        <Name><EffectiveName Value="Bass" /><UserName Value="Bass" /></Name>
        <DeviceChain><Devices>
          <Operator />
          <PluginDevice Id="5"><PluginDesc><VstPluginInfo><PlugName Value="Serum" /></VstPluginInfo></PluginDesc></PluginDevice>
          <Eq8 />
        </Devices></DeviceChain>
      </MidiTrack>
      <AudioTrack Id="11">
        <Name><EffectiveName Value="Kick" /></Name>
        <DeviceChain><Devices><Compressor2 /></Devices></DeviceChain>
        <SampleRef><FileRef>
          <RelativePath Value="../../Samples/Drums/kick 909.wav" />
          <Path Value="/Users/x/Samples/Drums/kick 909.wav" />
        </FileRef></SampleRef>
      </AudioTrack>
      <ReturnTrack Id="12">
        <Name><EffectiveName Value="A-Reverb" /></Name>
        <DeviceChain><Devices><Reverb /></Devices></DeviceChain>
      </ReturnTrack>
    </Tracks>
    <MasterTrack>
      <Name><EffectiveName Value="Master" /></Name>
      <DeviceChain><Devices><Limiter /></Devices></DeviceChain>
    </MasterTrack>
    <Scenes><Scene Id="0" /><Scene Id="1" /><Scene Id="2" /></Scenes>
  </LiveSet>
</Ableton>`;
const als = gzipSync(Buffer.from(alsXml, "utf8"));

// ---- run ----

let failed = 0;
const check = (label: string, haystack: string, needle: string) => {
  const ok = haystack.includes(needle);
  console.log(`  ${ok ? "✅" : "❌"} ${label}: ${needle}`);
  if (!ok) failed++;
};

console.log("== MIDI ==");
const midiOut = parseMidi(smf);
console.log(midiOut + "\n");
check("header", midiOut, "format 1, 2 track(s), 480 ticks/quarter");
check("duration", midiOut, "4.0 秒");
check("tempo", midiOut, "120.0 BPM");
check("time sig", midiOut, "4/4");
check("key", midiOut, "C major");
check("track name", midiOut, '"Bass"');
check("program", midiOut, "Electric Bass (finger)");
check("note count", midiOut, "8 个音符");
check("range", midiOut, "C3–C4");
check("histogram", midiOut, "C×2");
check("cc", midiOut, "2 条 CC");
check("first note", midiOut, "0:C3(1b)");

console.log("== ALS ==");
const alsOut = summarizeAls(als);
console.log(alsOut + "\n");
check("version", alsOut, "Live 12 1.5");
check("tempo", alsOut, "128.5 BPM");
check("time sig", alsOut, "3/4");
check("scenes", alsOut, "3 个场景");
check("group", alsOut, "[编组] Drums Bus");
check("stock device", alsOut, "GlueCompressor");
check("midi track", alsOut, "[MIDI] Bass");
check("chain", alsOut, "Operator → Serum → Eq8");
check("audio track", alsOut, "[音频] Kick");
check("sample basename", alsOut, "kick 909.wav");
check("return", alsOut, "[返送] A-Reverb");
check("master", alsOut, "[总线] Master");

console.log("== describeBinaryAttachment ==");
const viaB64 = describeBinaryAttachment("test.mid", "midi", smf.toString("base64"));
check("midi round-trip", viaB64, "Electric Bass (finger)");
const broken = describeBinaryAttachment("junk.mid", "midi", Buffer.from("not a midi").toString("base64"));
check("graceful failure", broken, "解析失败");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
