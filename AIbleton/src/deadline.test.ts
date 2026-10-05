import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { withDeadline } from "./deadline.js";

// These run against the native path (Node provides AbortSignal.timeout/any,
// same as the current Extensions SDK sandbox).

test("the ceiling fires and timedOut() reports it", async () => {
  const dl = withDeadline(undefined, 20);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(dl.signal.aborted, true);
  assert.equal(dl.timedOut(), true);
  dl.dispose();
});

test("parent abort wins over the ceiling and is not a timeout", async () => {
  const ctl = new AbortController();
  const dl = withDeadline(ctl.signal, 60_000);
  ctl.abort();
  assert.equal(dl.signal.aborted, true);
  assert.equal(dl.timedOut(), false);
  dl.dispose();
});

test("a pre-aborted parent aborts the derived signal immediately", () => {
  const ctl = new AbortController();
  ctl.abort();
  const dl = withDeadline(ctl.signal, 60_000);
  assert.equal(dl.signal.aborted, true);
  assert.equal(dl.timedOut(), false);
  dl.dispose();
});

// Older Live runtimes throw "AbortSignal is not defined" on a bare reference,
// so the fallback must engage when the global is missing entirely. Verified in
// a child process that deletes the global before loading the module.
test("fallback path works without the AbortSignal global", () => {
  const deadlineUrl = new URL("./deadline.ts", import.meta.url).href;
  const script = `
    delete globalThis.AbortSignal;
    const { withDeadline } = await import(${JSON.stringify(deadlineUrl)});

    const dl = withDeadline(undefined, 20);
    await new Promise((r) => setTimeout(r, 80));
    if (!dl.signal.aborted || !dl.timedOut()) process.exit(1);

    const ctl = new AbortController();
    const dl2 = withDeadline(ctl.signal, 60_000);
    ctl.abort();
    if (!dl2.signal.aborted || dl2.timedOut()) process.exit(1);

    const dl3 = withDeadline(undefined, 20);
    dl3.dispose();
    await new Promise((r) => setTimeout(r, 80));
    if (dl3.signal.aborted) process.exit(1);
  `;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
});
