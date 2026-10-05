import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { readAll, readAllBinary } from "./http.js";

const TEXT = "搜索超时 — 检查网络或代理；dark techno 采样已就绪 ✓";

/** Split a string's UTF-8 bytes at every possible boundary — including right
 * through the middle of multi-byte characters. */
function splitEveryByte(s: string): Buffer[] {
  const bytes = Buffer.from(s, "utf8");
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3));
  return chunks;
}

test("readAll decodes multi-byte characters split across chunks (node stream)", async () => {
  const stream = Readable.from(splitEveryByte(TEXT));
  assert.equal(await readAll(stream), TEXT);
});

test("readAll decodes via StringDecoder for plain async iterables", async () => {
  async function* chunks(): AsyncIterable<Buffer> {
    yield* splitEveryByte(TEXT);
  }
  // Not a node Readable → the fallback decoder path, which must also be
  // split-safe (this is what older Live runtimes always take).
  assert.equal(await readAll(chunks()), TEXT);
});

test("readAllBinary concatenates bytes unchanged", async () => {
  const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  async function* chunks(): AsyncIterable<Buffer> {
    yield data.subarray(0, 100);
    yield data.subarray(100);
  }
  assert.ok((await readAllBinary(chunks())).equals(data));
});

// Older Live sandboxes lack the Response global entirely — the StringDecoder
// path must engage even for node Readable streams.
test("readAll works without the Response global", () => {
  const httpUrl = new URL("./http.ts", import.meta.url).href;
  const script = `
    import { Readable } from "node:stream";
    import { Buffer } from "node:buffer";
    delete globalThis.Response;
    const { readAll } = await import(${JSON.stringify(httpUrl)});
    const text = ${JSON.stringify(TEXT)};
    const bytes = Buffer.from(text, "utf8");
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3));
    const out = await readAll(Readable.from(chunks));
    if (out !== text) process.exit(1);
  `;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
});
