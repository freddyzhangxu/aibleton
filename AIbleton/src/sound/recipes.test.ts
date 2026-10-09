import assert from "node:assert/strict";
import test from "node:test";

import { SOUND_RECIPES, type SoundRecipeId } from "./recipes.js";

test("guitar timbre recipes require matching one-shot local samples and declare a fallback", () => {
  const recipes = new Map(Object.values(SOUND_RECIPES).map((recipe) => [recipe.id, recipe]));
  const guitarRecipes = ["guitar_acoustic", "guitar_clean", "guitar_muted", "guitar_overdrive"] as const;

  for (const id of guitarRecipes) {
    const recipe = recipes.get(id as SoundRecipeId);
    assert.ok(recipe, `missing ${id}`);
    assert.equal(recipe.role, "guitar", id);
    assert.equal(recipe.source, "sample", id);
    assert.equal(recipe.samplePlayback, "one_shot", id);
    assert.equal(recipe.fallbackInstrument, id === "guitar_overdrive" ? "Wavetable" : "Drift", id);
    assert.ok(recipe.sampleEvidenceGroups?.length, `${id} must verify filename evidence`);
  }
});

test("guitar sample evidence separates acoustic, clean, muted, and overdriven files", () => {
  const recipes = new Map(Object.values(SOUND_RECIPES).map((recipe) => [recipe.id, recipe]));
  const terms = (id: SoundRecipeId) => recipes.get(id)?.sampleEvidenceGroups?.flat().join(" ").toLowerCase() ?? "";

  assert.match(terms("guitar_acoustic"), /nylon|acoustic/);
  assert.match(terms("guitar_clean"), /clean|hollowbody|jazz/);
  assert.match(terms("guitar_muted"), /muted|funk/);
  assert.match(terms("guitar_overdrive"), /overdrive|distorted|rock/);
});

test("guitar recipe query sets target actual sample names for each timbre", () => {
  const recipes = new Map(Object.values(SOUND_RECIPES).map((recipe) => [recipe.id, recipe]));
  const queries = (id: SoundRecipeId) => recipes.get(id)?.sampleQueries.join(" ").toLowerCase() ?? "";

  assert.match(queries("guitar_acoustic"), /nylon guitar|acoustic guitar/);
  assert.match(queries("guitar_clean"), /clean electric guitar|hollowbody guitar/);
  assert.match(queries("guitar_muted"), /muted guitar|funk guitar/);
  assert.match(queries("guitar_overdrive"), /overdrive guitar|distorted electric guitar/);
});
