/**
 * Offline unit test for src/samplemeta.ts — BPM/key filename parsing,
 * synonym expansion, query parsing and ranking.
 * Run: npx tsx scripts/test-samplemeta.ts
 */
import {
  normalize,
  parseBpm,
  parseKey,
  parseSampleQuery,
  searchSampleIndex,
  toSampleEntry,
  type SampleEntry,
} from "../src/samplemeta.js";

let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failed = true;
};

// ---- normalize ----
check(normalize("DSOH_124-bpm/Amin Pad.WAV") === "dsoh 124 bpm amin pad wav", "normalize: separators → space");

// ---- parseBpm ----
check(parseBpm("kick 124 bpm") === 124, "bpm: '124 bpm'");
check(parseBpm("loop 140bpm") === 140, "bpm: '140bpm' compact");
check(parseBpm("bpm 98 deep pad") === 98, "bpm: 'bpm 98' prefix");
check(parseBpm("dark pad 125 v2") === 125, "bpm: bare 125 (v2 ignored)");
check(parseBpm("808 kick") === undefined, "bpm: 808 is a drum machine, not tempo");
check(parseBpm("sh 101 bass") === undefined, "bpm: SH-101 gear number blacklisted");
check(parseBpm("juno 106 pad") === undefined, "bpm: JUNO-106 gear number blacklisted");
check(parseBpm("hat 16th 64 loop") === undefined, "bpm: 16/64 below range");
check(parseBpm("dark pad") === undefined, "bpm: none");

// ---- parseKey ----
const k = (s: string) => parseKey(s)?.label;
check(k("Deep Pad Am 124") === "Am", "key: 'Am'");
check(k("bass amin loop") === "Am", "key: 'amin' compact lowercase");
check(k("Lead C#m 140") === "C#m", "key: 'C#m'");
check(k("Brass Bb minor") === "Bbm", "key: 'Bb minor' spaced");
check(k("Chord Fmaj 100") === "F", "key: 'Fmaj'");
check(k("Pad F# 124") === "F#", "key: bare 'F#'");
check(k("Strings A Major") === "A", "key: 'A Major'");
check(k("FM Bass 124") === undefined, "key: 'FM' = synthesis, blacklisted");
check(k("GM Drums") === undefined, "key: 'GM' = General MIDI, blacklisted");
check(k("Amplitude Riser") === undefined, "key: 'Amplitude' not Am (word boundary)");
check(k("take a chance") === undefined, "key: lowercase 'a' not a key");
check(parseKey("Pad Am")?.semitone === 9 && parseKey("Pad Am")?.minor === true, "key: Am → semitone 9 minor");
check(parseKey("Pad Bb")?.semitone === 10, "key: Bb → semitone 10");

// ---- toSampleEntry ----
const e1 = toSampleEntry("/Users/x/Splice/packs/DSOH/loops/DSOH_124_bpm_Amin_dark_pad_loop.wav");
check(e1.bpm === 124, "entry: bpm from filename");
check(e1.ks === 9 && e1.km === true, "entry: Am from filename");
const e2 = toSampleEntry("/packs/Tech House 126 BPM/loops/groovy_bass_loop.wav");
check(e2.bpm === 126, "entry: bpm falls back to folder");
const e3 = toSampleEntry("C:\\Samples\\Drums\\Kick Hard.wav");
check(e3.ks === undefined, "entry: Windows drive C: not parsed as key of C");
check(toSampleEntry("/kits/SH-101/SH-101 Bass C2.wav").bpm === undefined, "entry: SH-101 filename no false bpm");

// ---- parseSampleQuery ----
const q1 = parseSampleQuery("dark pad 124 bpm am");
check(q1.bpm === 124 && q1.key?.label === "Am" && q1.terms.join(",") === "dark,pad", "query: bpm+key+terms split");
const q2 = parseSampleQuery("808 kick");
check(q2.bpm === undefined && q2.terms.join(",") === "808,kick", "query: 808 stays a term");
const q3 = parseSampleQuery("tech house loop 126");
check(q3.bpm === 126 && q3.terms.join(",") === "tech,house,loop", "query: bare 126 → bpm");
const q4 = parseSampleQuery("a dark pad");
check(q4.key === undefined && q4.terms.join(",") === "dark,pad", "query: article 'a' stripped, not key A");
const q5 = parseSampleQuery("bass in A");
check(q5.key?.label === "A" && q5.terms.join(",") === "bass", "query: 'in A' → key A");

// ---- search: fake index ----
const paths = [
  "/Splice/dsoh/DSOH_124_bpm_Amin_dark_pad_loop.wav",
  "/Splice/dsoh/DSOH_126_bpm_Amin_dark_pad_loop.wav",
  "/Splice/dsoh/DSOH_124_bpm_Cmaj_bright_pad_loop.wav",
  "/Splice/industrial/Industrial_rumble_kick_120.wav",
  "/Splice/kicks/Kick_808_Deep.wav",
  "/Splice/hats/Closed_Hat_Tight.wav",
  "/Splice/vox/whatever_chops_124.wav",
  "/User Library/Piano Rhodes Am.wav",
  "/Core Library/Drums/Snare 909.aif",
];
const index: SampleEntry[] = paths.map(toSampleEntry);
const r = (q: string) => searchSampleIndex(index, q, 30);

// AND semantics preserved
check(r("pad").total === 3, "search: 'pad' → 3 pads");
check(r("pad am").total === 3, "search: 'pad am' — key ranks, doesn't filter");
check(r("kick snare").total === 0, "search: AND — no file has both kick and snare");
// Ranking: exact bpm+key first, near bpm second, relative key (C major = Am relative) third.
// ("dark" would AND-exclude the Cmaj file — it has no dark synonym in its path.)
const pads = r("pad 124 am").results;
check(pads[0] === paths[0], "rank: exact 124/Am first");
check(pads[1] === paths[1], "rank: 126 (near bpm) second");
check(pads[2] === paths[2], "rank: C major (relative of Am) third");
// Synonyms
check(r("dark kick").results[0] === paths[3], "synonym: 'dark' → rumble/industrial");
check(r("punchy hat").results[0] === paths[5], "synonym: 'punchy' → tight");
check(r("vocal").results[0] === paths[6], "synonym: 'vocal' → vox folder");
check(r("keys").results[0] === paths[7], "synonym: 'keys' → rhodes");
// Short-token strictness: 'hat' must NOT match 'whatever'
check(!r("hat").results.includes(paths[6]), "short term: 'hat' ≠ 'whatever'");
check(r("hat").results.includes(paths[5]), "short term: 'hat' matches 'Closed Hat'");
// 909 as term
check(r("909 snare").total === 1, "search: '909 snare'");
// parsed echo
const parsed = r("dark pad 124 am").parsed;
check(parsed.bpm === 124 && parsed.key === "Am" && parsed.terms.join(",") === "dark,pad", "search: parsed echo");
// zero results → suggestion
check(typeof r("zyxel nonsuch").suggestion === "string", "search: zero results carry a suggestion");

process.exit(failed ? 1 : 0);
