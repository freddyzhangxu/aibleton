import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");

test("progress reports actual completed operations and batch completion, without a guessed percentage", () => {
  const start = html.indexOf("function progressLabel(");
  const end = html.indexOf("function thinkingLabel(", start);
  assert.ok(start >= 0 && end > start);
  const context = { t: (key: string) => ({ completedOperations: "Completed {n} operations", batchProgress: "Batch {n}/{total}" }[key]) };
  const label = (progress: unknown) => runInNewContext(html.slice(start, end) + "\nprogressLabel(progress)", { ...context, progress });
  assert.equal(label(null), "");
  assert.equal(label({ completedTools: 0 }), "");
  assert.equal(label({ completedTools: 3 }), " · Completed 3 operations");
  assert.equal(label({ completedTools: 3, plan: { completed: 1, total: 4 } }), " · Batch 1/4");
  assert.equal(label({ completedTools: -1 }), "");
});
