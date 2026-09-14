import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ctx } from "./state.js";
import { setContextPrompt, updateSetContext } from "./setcontext.js";

/** Minimal Ctx stub: a song with a document handle id, N tracks/scenes, tempo. */
function ctx(handleId: bigint, opts?: { tracks?: number; scenes?: number; tempo?: number }): Ctx {
  return {
    application: {
      song: {
        handle: { id: handleId },
        tempo: opts?.tempo ?? 120,
        tracks: Array.from({ length: opts?.tracks ?? 2 }, () => ({})),
        scenes: Array.from({ length: opts?.scenes ?? 4 }, () => ({})),
      },
    },
  } as unknown as Ctx;
}

describe("setcontext", () => {
  it("injects the current-Set summary once a turn ran", () => {
    updateSetContext(ctx(1n, { tracks: 3, scenes: 5, tempo: 124.4 }));
    const prompt = setContextPrompt();
    assert.match(prompt, /Current Live Set: 3 tracks, 5 scenes, 124 BPM/);
    assert.doesNotMatch(prompt, /SET CHANGED/);
  });

  it("warns for one turn when the document handle changes", () => {
    assert.deepEqual(updateSetContext(ctx(1n)), { key: "1", changed: false });
    assert.deepEqual(updateSetContext(ctx(2n)), { key: "2", changed: true });
    assert.match(setContextPrompt(), /SET CHANGED/);
    // Next turn with the same document: warning clears, summary stays.
    updateSetContext(ctx(2n));
    const prompt = setContextPrompt();
    assert.doesNotMatch(prompt, /SET CHANGED/);
    assert.match(prompt, /Current Live Set/);
  });

  it("missing handle is a silent no-op", () => {
    const before = setContextPrompt();
    updateSetContext({ application: { song: { handle: {} } } } as unknown as Ctx);
    assert.equal(setContextPrompt(), before);
  });
});
