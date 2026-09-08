/**
 * Fixture test for src/movebundle.ts (.ablbundle → analyzeSong).
 * Run: npx tsx scripts/test-movebundle.ts [optional-real-bundle.ablbundle]
 *
 * Builds a synthetic Move bundle in memory (STORE entries with the
 * data-descriptor flag set, exactly like firmware 2.1 writes them, plus one
 * DEFLATE entry) and asserts the whole chain: unzip → parseMoveBundle →
 * moveSongToSnapshot → analyzeSong. No Move, no Live, no network.
 *
 * With a path argument it instead parses that real bundle and prints the
 * full tool result — the real-device check.
 */
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import assert from "node:assert";
import {
  moveExtras,
  moveSongToSnapshot,
  parseMoveBundle,
  unzipEntries,
} from "../src/movebundle.js";
import { analyzeSong } from "../src/analysis/index.js";

// ---------------------------------------------------------------------------
// Minimal zip writer (STORE/DEFLATE + data descriptor, mirrors Move output)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntrySpec {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

function buildZip(entries: ZipEntrySpec[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const payload = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0x0808, 6); // flags: data descriptor + UTF-8
    local.writeUInt16LE(method, 8);
    // sizes/crc stay 0 in the local header (data descriptor follows),
    // exactly like the Move's own writer — the reader must use central dir.
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, payload);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(payload.length, 8);
    desc.writeUInt32LE(e.data.length, 12);
    chunks.push(desc);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0808, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt32LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += 30 + nameBuf.length + payload.length + 16;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

/** 1-second 8kHz mono WAV — just enough header for wavSeconds. */
function tinyWav(seconds = 1): Buffer {
  const rate = 8000;
  const dataBytes = rate * seconds;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([buf, Buffer.alloc(dataBytes)]);
}

// ---------------------------------------------------------------------------
// Synthetic Move Set
// ---------------------------------------------------------------------------

const SONG = {
  $schema: "http://tech.ableton.com/schema/song/1.8.3/song.json",
  tempo: 133,
  timeSignature: { upper: 3, lower: 4 },
  rootNote: 2,
  scale: "Minor",
  scenes: [{ name: "A" }, { name: "B" }],
  grooves: [{ name: "Swing 16ths" }],
  tracks: [
    {
      kind: "midi",
      name: "Drums",
      clipSlots: [
        {
          clip: {
            name: "beat",
            isEnabled: true,
            region: { start: 0, end: 6, loop: { start: 0, end: 6, isEnabled: true } }, // 2 bars of 3/4
            notes: [
              { noteNumber: 36, startTime: 0, duration: 0.25, velocity: 100 },
              { noteNumber: 36, startTime: 3, duration: 0.25, velocity: 96 },
              { noteNumber: 38, startTime: 1.5, duration: 0.25, velocity: 90 },
              { noteNumber: 42, startTime: 0.75, duration: 0.25, velocity: 70 },
            ],
          },
        },
        { clip: null },
      ],
      devices: [
        {
          kind: "instrumentRack",
          name: "Kit",
          chains: [
            {
              devices: [
                {
                  kind: "drumRack",
                  name: "Kit",
                  chains: [{ devices: [{ kind: "drumCell", name: "" }] }],
                },
              ],
            },
          ],
        },
      ],
      mixer: { pan: 0, volume: 0, speakerOn: true, "solo-cue": false },
    },
    {
      kind: "midi",
      name: "Bass",
      clipSlots: [
        {
          clip: {
            name: "",
            isEnabled: false, // disabled clip → muted
            region: { start: 0, end: 6, loop: { start: 0, end: 6, isEnabled: true } },
            notes: [{ noteNumber: 38, startTime: 0, duration: 1, velocity: 100 }],
          },
        },
        {
          clip: {
            name: "empty",
            isEnabled: true,
            region: { start: 0, end: 6, loop: { start: 0, end: 6, isEnabled: true } },
            notes: [], // audible shell, no notes → should be muted in snapshot
          },
        },
      ],
      devices: [{ kind: "wavetable", name: "Wavetable" }],
      mixer: { pan: -0.5, volume: -7.4, speakerOn: true, "solo-cue": false },
    },
    {
      kind: "audio",
      name: "Guitar Loop",
      clipSlots: [
        {
          clip: {
            name: "",
            isEnabled: true,
            region: { start: 0, end: 12, loop: { start: 0, end: 24, isEnabled: true } },
            sampleUri: "Samples/Guitar%20Loop.wav",
          },
        },
      ],
      devices: [],
      mixer: { pan: 0.25, volume: 1.7, speakerOn: false, "solo-cue": false }, // muted track
    },
  ],
};

function syntheticBundle(): Buffer {
  return buildZip([
    { name: "Song.abl", data: Buffer.from(JSON.stringify(SONG), "utf8") },
    {
      name: "BundleInfo.json",
      data: Buffer.from(
        JSON.stringify({
          originalSampleUris: {
            "Samples/Guitar%20Loop.wav": "ableton:/packs/abl-core-library/Samples/Guitar%20Loop.wav",
          },
        }),
        "utf8",
      ),
    },
    { name: "Samples/Guitar%20Loop.wav", data: tinyWav(2) },
    { name: "Samples/User Rec.wav", data: tinyWav(1), deflate: true }, // DEFLATE path
  ]);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function main() {
  const realPath = process.argv[2];
  if (realPath) {
    const bundle = parseMoveBundle(readFileSync(realPath));
    const analysis = analyzeSong(moveSongToSnapshot(bundle.song));
    console.log(JSON.stringify({ ...analysis, move: moveExtras(bundle) }, null, 1));
    return;
  }

  const zip = syntheticBundle();

  // unzip: STORE with descriptor + DEFLATE both decode
  const entries = unzipEntries(zip);
  assert.strictEqual(entries.size, 4, "entry count");
  assert.strictEqual(entries.get("Samples/User Rec.wav")?.length, tinyWav(1).length, "deflate size");
  assert.ok(entries.get("Song.abl")!.toString("utf8").includes('"Phrygian"') === false);

  // parse
  const bundle = parseMoveBundle(zip);
  assert.strictEqual(bundle.schemaTag, "1.8.3");
  assert.strictEqual(bundle.song.tempo, 133);
  assert.strictEqual(bundle.samples.length, 2);
  const guitar = bundle.samples.find((s) => s.name === "Samples/Guitar Loop.wav")!;
  assert.strictEqual(guitar.seconds, 2, "wav seconds (store) — byteRate at fmt+16, not sampleRate");
  assert.strictEqual(guitar.origin, "pack");
  const rec = bundle.samples.find((s) => s.name === "Samples/User Rec.wav")!;
  assert.strictEqual(rec.seconds, 1, "wav seconds (deflate)");
  assert.strictEqual(rec.origin, "user");

  // snapshot conversion
  const snap = moveSongToSnapshot(bundle.song);
  assert.strictEqual(snap.tempo, 133);
  assert.deepStrictEqual(snap.timeSig, { numerator: 3, denominator: 4 });
  assert.strictEqual(snap.liveScale.mode, true, "known scale keeps mode on");
  assert.strictEqual(snap.liveScale.name, "Minor");
  assert.strictEqual(snap.liveScale.root, 2);
  assert.strictEqual(snap.sceneCount, 2);
  assert.strictEqual(snap.tracks.length, 3);

  const [drums, bass, gtr] = snap.tracks;
  assert.deepStrictEqual(drums.drumPads, [36, 38, 42], "pads from played pitches");
  assert.strictEqual(drums.clips[0].start, null, "session clip");
  assert.strictEqual(drums.clips[0].scene, 0);
  assert.strictEqual(drums.clips[0].duration, 6);
  assert.strictEqual(drums.clips[0].notes!.length, 4);
  assert.strictEqual(bass.clips[0].muted, true, "disabled clip muted");
  assert.strictEqual(bass.clips[1].muted, true, "noteless MIDI clip muted");
  assert.strictEqual(gtr.mute, true, "speakerOn=false mutes track");
  assert.strictEqual(gtr.clips[0].file, "Guitar Loop.wav", "sampleUri basename decoded");
  assert.strictEqual(gtr.clips[0].kind, "audio");
  // region ∩ loop clamp: loop 0–24 vs region 0–12 → window 12
  assert.strictEqual(gtr.clips[0].loopEnd, 12);

  // unknown scale falls back without lying
  const odd = moveSongToSnapshot({ ...SONG, scale: "Enigmatic" });
  assert.strictEqual(odd.liveScale.mode, false);
  assert.strictEqual(odd.liveScale.intervals.length, 12);

  // end-to-end: the shared engine accepts the Move snapshot
  const analysis = analyzeSong(snap);
  assert.strictEqual(analysis.tempo, 133);
  assert.strictEqual(analysis.timeSig, "3/4");
  assert.strictEqual(analysis.arrangement, null, "no arrangement on Move");
  assert.strictEqual(analysis.session.clips, 1, "only audible MIDI session clips counted");
  assert.ok(
    analysis.issues.some((i) => i.startsWith("NO_ARRANGEMENT")),
    "flags NO_ARRANGEMENT",
  );
  assert.strictEqual(analysis.tracks[0].role, "drums");

  // extras
  const extras = moveExtras(bundle);
  assert.strictEqual(extras.schema, "1.8.3");
  assert.strictEqual(extras.drumTracks, 1);
  assert.strictEqual(extras.melodicTracks, 1);
  assert.strictEqual(extras.audioTracks, 1);
  assert.deepStrictEqual(extras.grooves, ["Swing 16ths"]);
  assert.strictEqual(extras.tracks[1].volumeDb, -7.4);
  assert.strictEqual(extras.tracks[2].muted, true);
  // per-track session stats (analysis.tracks only covers arrangement clips)
  assert.strictEqual(extras.tracks[0].notes, 4);
  assert.strictEqual(extras.tracks[0].range, "C2-F#2");
  assert.deepStrictEqual(extras.tracks[0].devices, ["Kit"]);
  assert.strictEqual(extras.tracks[1].clips, 0, "disabled+empty clips are not audible");
  assert.strictEqual(extras.tracks[1].notes, 0);
  assert.strictEqual(extras.tracks[2].clips, 1);
  assert.deepStrictEqual(extras.tracks[2].files, ["Guitar Loop.wav"]);

  console.log("PASS test-movebundle");
}

main();
