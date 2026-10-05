/**
 * multipart/form-data bodies shared by audiogen (Stable Audio) and move
 * (file upload).
 *
 * The current Extensions SDK exposes FormData + Response in the sandbox, so
 * boundary serialization is native and binary-safe; older Live runtimes fall
 * back to the hand-rolled builders. Runtime access goes through globalThis —
 * never bare identifiers — and any partial-undici surprise (a global exists
 * but misbehaves) drops to the fallback via try/catch.
 */

import { Buffer } from "node:buffer";

const NativeFormData = (globalThis as { FormData?: typeof FormData }).FormData;
const NativeResponse = (globalThis as { Response?: typeof Response }).Response;
const NativeBlob = (globalThis as { Blob?: typeof Blob }).Blob;

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

/** Serialize a FormData through a native Response: the headers carry the
 * generated boundary, arrayBuffer() the encoded bytes. null when the sandbox
 * globals are missing or incomplete. */
async function serializeNative(build: (fd: FormData) => void): Promise<MultipartBody | null> {
  if (typeof NativeFormData !== "function" || typeof NativeResponse !== "function") return null;
  try {
    const fd = new NativeFormData();
    build(fd);
    const res = new NativeResponse(fd);
    const contentType = res.headers.get("content-type");
    if (!contentType) return null;
    return { body: Buffer.from(await res.arrayBuffer()), contentType };
  } catch {
    return null;
  }
}

/** Text fields only (Stable Audio). */
export async function multipartFields(fields: Record<string, string>): Promise<MultipartBody> {
  const native = await serializeNative((fd) => {
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  });
  if (native) return native;
  const boundary = "----aibleton" + Math.random().toString(36).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  return {
    body: Buffer.from(body + `--${boundary}--\r\n`, "utf8"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** One binary file part (Move upload). The native path additionally needs
 * Blob, which is not among the SDK's announced globals, so a sandbox without
 * it takes the hand-rolled path. */
export async function multipartFile(
  field: string,
  filename: string,
  data: Buffer,
): Promise<MultipartBody> {
  const native =
    typeof NativeBlob === "function"
      ? await serializeNative((fd) => {
          // Copy into a plain ArrayBuffer-backed view: Blob parts reject the
          // Buffer's ArrayBufferLike (possibly shared) backing store.
          fd.append(field, new NativeBlob!([new Uint8Array(data)]), filename);
        })
      : null;
  if (native) return native;
  const boundary = `----aibleton-move-${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([head, data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
