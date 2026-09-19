import assert from "node:assert/strict";
import test from "node:test";
import { createContextMenuRegistrationManager, type ContextMenuUi } from "./menu-lifecycle.js";

type Scope = "MidiTrack" | "AudioTrack";

function ui(events: string[], rejectCleanup = false): ContextMenuUi<Scope> {
  return {
    async registerContextMenuAction(scope) {
      events.push(`register:${scope}`);
      return async () => {
        events.push(`cleanup:${scope}`);
        if (rejectCleanup) throw new Error(`cannot clean ${scope}`);
      };
    },
  };
}

test("first registration creates one action per scope", async () => {
  const events: string[] = [];
  const manager = createContextMenuRegistrationManager<Scope>();
  await manager.replace(ui(events), ["MidiTrack", "AudioTrack"], "Open", "ai.open");
  assert.deepEqual(events, ["register:MidiTrack", "register:AudioTrack"]);
});

test("replacement cleans old actions before registering new ones", async () => {
  const events: string[] = [];
  const manager = createContextMenuRegistrationManager<Scope>();
  await manager.replace(ui(events), ["MidiTrack", "AudioTrack"], "Open", "ai.open");
  events.length = 0;
  await manager.replace(ui(events), ["MidiTrack", "AudioTrack"], "Open", "ai.open");
  assert.deepEqual(events, [
    "cleanup:MidiTrack", "cleanup:AudioTrack", "register:MidiTrack", "register:AudioTrack",
  ]);
});

test("concurrent replacements serialize cleanup and registration", async () => {
  const events: string[] = [];
  const manager = createContextMenuRegistrationManager<Scope>();
  await Promise.all([
    manager.replace(ui(events), ["MidiTrack"], "Open", "ai.open"),
    manager.replace(ui(events), ["AudioTrack"], "Open", "ai.open"),
  ]);
  assert.deepEqual(events, ["register:MidiTrack", "cleanup:MidiTrack", "register:AudioTrack"]);
});

test("a failed cleanup does not block replacement", async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const manager = createContextMenuRegistrationManager<Scope>((message) => warnings.push(message));
  await manager.replace(ui(events, true), ["MidiTrack"], "Open", "ai.open");
  events.length = 0;
  await manager.replace(ui(events), ["AudioTrack"], "Open", "ai.open");
  assert.deepEqual(events, ["cleanup:MidiTrack", "register:AudioTrack"]);
  assert.deepEqual(warnings, ["AIbleton: failed to unregister an old context-menu action"]);
});
