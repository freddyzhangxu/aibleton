import assert from "node:assert/strict";
import test from "node:test";
import { MENU_SCOPES } from "./menu-scopes.js";

test("menu scopes avoid Arrangement and Session Clip overlap", () => {
  assert.ok(MENU_SCOPES.includes("MidiClip"));
  assert.ok(MENU_SCOPES.includes("AudioClip"));
  assert.ok(!MENU_SCOPES.includes("MidiTrack.ArrangementSelection" as never));
  assert.ok(!MENU_SCOPES.includes("AudioTrack.ArrangementSelection" as never));
  assert.ok(!MENU_SCOPES.includes("ClipSlotSelection" as never));
});
