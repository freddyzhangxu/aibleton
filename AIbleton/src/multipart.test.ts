import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { multipartFields, multipartFile } from "./multipart.js";

/** Parse a produced body back with undici's standards-compliant parser — the
 * strongest proof a server will read it the same way. */
function parse(body: Buffer, contentType: string): Promise<FormData> {
  return new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
}

// Native path (Node provides FormData/Response/Blob, same as the current SDK).

test("text fields round-trip through a standards-compliant parser", async () => {
  const { body, contentType } = await multipartFields({
    prompt: "dark techno, 140 bpm",
    duration: "30",
    output_format: "wav",
  });
  assert.match(contentType, /^multipart\/form-data; ?boundary=/);
  const fd = await parse(body, contentType);
  assert.equal(fd.get("prompt"), "dark techno, 140 bpm");
  assert.equal(fd.get("duration"), "30");
  assert.equal(fd.get("output_format"), "wav");
});

test("binary file part round-trips byte-identical", async () => {
  const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); // 0x00–0xFF
  const { body, contentType } = await multipartFile("file", "kick 01.wav", data);
  const fd = await parse(body, contentType);
  const file = fd.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "kick 01.wav");
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(data));
});

// Fallback paths: older Live sandboxes lack these globals entirely. Verified
// in a child process that deletes them before loading the module (the saved
// Response constructor still serves as the parser).
test("fallbacks engage when the sandbox lacks FormData/Response/Blob", () => {
  const multipartUrl = new URL("./multipart.ts", import.meta.url).href;
  const script = `
    import { Buffer } from "node:buffer";
    const NativeResponse = globalThis.Response;
    delete globalThis.FormData;
    delete globalThis.Response;
    delete globalThis.Blob;
    const { multipartFields, multipartFile } = await import(${JSON.stringify(multipartUrl)});
    const parse = (body, contentType) =>
      new NativeResponse(body, { headers: { "content-type": contentType } }).formData();

    const fields = await multipartFields({ prompt: "dark techno", duration: "30" });
    const fd = await parse(fields.body, fields.contentType);
    if (fd.get("prompt") !== "dark techno" || fd.get("duration") !== "30") process.exit(1);

    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const file = await multipartFile("file", "kick 01.wav", data);
    const fd2 = await parse(file.body, file.contentType);
    const f = fd2.get("file");
    if (!f || f.name !== "kick 01.wav") process.exit(1);
    if (!Buffer.from(await f.arrayBuffer()).equals(data)) process.exit(1);
  `;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
});
