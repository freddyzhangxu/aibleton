import assert from "node:assert/strict";
import test from "node:test";

import { instrumentPromptFor } from "./instruments.js";

test("keeps drum guidance source-focused and only injects it for drum requests", () => {
  const drums = instrumentPromptFor("Create a techno drum groove", "Create a techno drum groove");
  assert.match(drums, /Drum kits and individual drum samples are sample sources/);
  assert.match(drums, /genre is a source-selection hint only/);
  assert.match(drums, /Do not prescribe per-pad synthesis or specific envelope, filter, or effect settings/);
  assert.match(drums, /get_drum_pad_sample.*before replacing/i);
  assert.match(drums, /replace_drum_pad_sample.*only for the requested pad/i);
  assert.match(drums, /If no sample source is available, keep the current pad sample/);
  assert.doesNotMatch(drums, /Kick → tight, punchy, focused low end/);

  const beat = instrumentPromptFor("Create a four-bar house beat", "Create a four-bar house beat");
  assert.match(beat, /genre is a source-selection hint only/);
  assert.doesNotMatch(beat, /Kick → rounded, warm, and steady/);

  const bass = instrumentPromptFor("Create a techno bassline", "Create a techno bassline");
  assert.doesNotMatch(bass, /Drum kits and individual drum samples/);
});
