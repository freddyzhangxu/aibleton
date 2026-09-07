/**
 * Real-library smoke test for the sample search upgrade — builds the index
 * from THIS machine's actual sample roots (Library.cfg discovery, same as
 * the extension, but outside the sandbox) and runs a few representative
 * queries. Checks performance and eyeballs result quality.
 * Run: npx tsx scripts/smoke-samplelib.ts
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { AUDIO_EXT, sampleRoots } from "../src/paths.js";
import { toSampleEntry, searchSampleIndex, type SampleEntry } from "../src/samplemeta.js";

const t0 = Date.now();
const files: string[] = [];
for (const root of sampleRoots()) {
  const stack = [root];
  while (stack.length && files.length < 200000) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) files.push(full);
    }
  }
}
const t1 = Date.now();
const index: SampleEntry[] = files.map(toSampleEntry);
const t2 = Date.now();
console.log(`roots: ${sampleRoots().join(" | ")}`);
console.log(`walk: ${t1 - t0}ms, meta parse: ${t2 - t1}ms, files: ${files.length}`);
const withBpm = index.filter((e) => e.bpm !== undefined).length;
const withKey = index.filter((e) => e.ks !== undefined).length;
console.log(
  `bpm coverage: ${withBpm} (${((100 * withBpm) / files.length).toFixed(1)}%), key coverage: ${withKey} (${((100 * withKey) / files.length).toFixed(1)}%)`,
);

for (const q of ["808 kick", "dark pad", "tech house loop 126", "vocal chop 124 am", "punchy snare"]) {
  const t3 = Date.now();
  const r = searchSampleIndex(index, q);
  console.log(`\n"${q}" → total ${r.total} (${Date.now() - t3}ms) parsed=${JSON.stringify(r.parsed)}`);
  for (const p of r.results.slice(0, 5)) console.log("  " + p.split("/").slice(-2).join("/"));
}
