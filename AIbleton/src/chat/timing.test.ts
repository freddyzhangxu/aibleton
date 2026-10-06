import test from "node:test";
import assert from "node:assert/strict";
import { measureAsync } from "./timing.js";

test("measureAsync logs a monotonic duration when work succeeds", async () => {
  const times = [10, 13.25];
  const lines: string[] = [];

  const result = await measureAsync("MODEL provider=test round=0", async () => "ok", (line) => lines.push(line), () => times.shift()!);

  assert.equal(result, "ok");
  assert.deepEqual(lines, ["TIMING MODEL provider=test round=0 elapsedMs=3.3 outcome=ok"]);
});

test("measureAsync logs failed work and preserves its error", async () => {
  const failure = new Error("network down");
  const lines: string[] = [];
  const times = [5, 7];

  await assert.rejects(
    measureAsync("MODEL provider=test round=1", async () => { throw failure; }, (line) => lines.push(line), () => times.shift()!),
    (error) => error === failure,
  );

  assert.deepEqual(lines, ["TIMING MODEL provider=test round=1 elapsedMs=2.0 outcome=error"]);
});

test("measureAsync does not let a diagnostic logger change the operation result", async () => {
  const result = await measureAsync("TOOL name=example", async () => 42, () => { throw new Error("disk full"); }, () => 1);
  assert.equal(result, 42);
});
