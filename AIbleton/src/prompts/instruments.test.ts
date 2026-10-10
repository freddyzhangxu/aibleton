import assert from "node:assert/strict";
import test from "node:test";

import { instrumentPromptFor } from "./instruments.js";

test("adds genre drum timbre guidance only when the request includes drums", () => {
  const drums = instrumentPromptFor("Create a techno drum groove", "Create a techno drum groove");
  assert.match(drums, /Techno aliases:.*Kick → tight, punchy, focused low end/);
  assert.match(drums, /search_samples.*pad role and requested timbre/i);
  assert.match(drums, /get_drum_pad_sample.*before replacing/i);
  assert.match(drums, /replace_drum_pad_sample.*only for the requested pad/i);
  assert.match(drums, /If no clear local match is found, keep the current pad sample/);

  const beat = instrumentPromptFor("Create a four-bar house beat", "Create a four-bar house beat");
  assert.match(beat, /House aliases:.*Kick → rounded, warm, and steady/);

  const bass = instrumentPromptFor("Create a techno bassline", "Create a techno bassline");
  assert.doesNotMatch(bass, /Techno aliases:.*Kick →/);
});
