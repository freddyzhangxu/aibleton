import assert from "node:assert/strict";
import test from "node:test";
import { MidiTrack } from "@ableton-extensions/sdk";

import type { SoundRecipeId } from "../sound/recipes.js";
import { clearSelectionContext } from "../setcontext.js";
import { toolState, type Ctx } from "../state.js";
import { applySoundRecipe } from "./soundrecipes.js";

function midiContext() {
  const track = Object.create(MidiTrack.prototype);
  Object.defineProperty(track, "name", { value: "1-MIDI", writable: true });
  Object.defineProperty(track, "devices", { value: [], writable: true });
  Object.defineProperty(track, "handle", { value: { id: 99n } });
  return {
    application: { song: { tracks: [track], scenes: [] } },
  } as unknown as Ctx;
}

test("allows the assistant-selected MIDI track when the request and Live have no explicit scope", async () => {
  const previousScope = toolState.activeExplicitEditScope;
  const previousGlobalIntent = toolState.activeGlobalIntent;
  const previousCreatedTrackHandles = [...toolState.activeCreatedTrackHandles];
  clearSelectionContext();
  toolState.activeCreatedTrackHandles.clear();
  toolState.activeCreatedTrackHandles.add("99");
  toolState.activeExplicitEditScope = { trackIndices: [], arrangementRanges: [] };
  toolState.activeGlobalIntent = false;

  try {
    // An invalid recipe reaches recipe validation only after the scope gate.
    // If the empty-scope default is still blocked, applySoundRecipe returns a
    // selection_scope_refused result instead of rejecting with this error.
    await assert.rejects(
      applySoundRecipe(midiContext(), {
        track_index: 0,
        track_name: "1-MIDI",
        recipe_id: "not-a-recipe" as SoundRecipeId,
      }),
      /未知音色方案/,
    );
  } finally {
    toolState.activeExplicitEditScope = previousScope;
    toolState.activeGlobalIntent = previousGlobalIntent;
    toolState.activeCreatedTrackHandles.clear();
    for (const id of previousCreatedTrackHandles) toolState.activeCreatedTrackHandles.add(id);
    clearSelectionContext();
  }
});

test("keeps an explicitly named track boundary when another track is targeted", async () => {
  const previousScope = toolState.activeExplicitEditScope;
  const previousGlobalIntent = toolState.activeGlobalIntent;
  clearSelectionContext();
  toolState.activeExplicitEditScope = { trackIndices: [1], arrangementRanges: [] };
  toolState.activeGlobalIntent = false;

  try {
    const result = await applySoundRecipe(midiContext(), {
      track_index: 0,
      track_name: "1-MIDI",
      recipe_id: "not-a-recipe" as SoundRecipeId,
    });

    assert.equal(result.executed, false);
    assert.equal(result.selection_scope_refused, true);
  } finally {
    toolState.activeExplicitEditScope = previousScope;
    toolState.activeGlobalIntent = previousGlobalIntent;
    clearSelectionContext();
  }
});
