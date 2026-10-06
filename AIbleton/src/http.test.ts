import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { readAll, readAllBinary, rawGet, rawPost } from "./http.js";

/** server.close() hangs while pooled keep-alive sockets sit idle — close them
 * explicitly so the test process can exit. */
async function closeServer(server: Server) {
  server.close();
  server.closeIdleConnections();
  await once(server, "close");
}

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

test("rawPost reuses one keep-alive connection across sequential requests", async () => {
  let connections = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  server.on("connection", () => connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`);
    for (let i = 0; i < 3; i++) {
      const res = await rawPost(url, {
        headers: { "content-type": "application/json" },
        body: "{}",
        proxy: null,
      });
      assert.equal(res.status, 200);
      assert.equal(await readAll(res.stream), '{"ok":true}');
    }
    assert.equal(connections, 1, "every request after the first must skip the handshake");
  } finally {
    await closeServer(server);
  }
});

test("rawGet retries once when the connection dies before the response", async () => {
  let requests = 0;
  let connections = 0;
  const server = createServer((req, res) => {
    requests++;
    if (requests === 1) {
      // Simulate a connection reset before any response bytes.
      req.socket.destroy();
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  server.on("connection", () => connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const res = await rawGet(new URL(`http://127.0.0.1:${address.port}/v1`), {
      headers: {},
      proxy: null,
    });
    assert.equal(await readAll(res.stream), '{"ok":true}');
    assert.equal(connections, 2, "the retry must dial a fresh connection");
  } finally {
    await closeServer(server);
  }
});

test("rawPost surfaces a proxy CONNECT rejection instead of hanging", async () => {
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      rawPost(new URL("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"), {
        headers: { "content-type": "application/json" },
        body: "{}",
        proxy: `http://127.0.0.1:${address.port}`,
      }),
      /CONNECT 失败.*407/,
    );
  } finally {
    proxy.close();
    await once(proxy, "close");
  }
});
