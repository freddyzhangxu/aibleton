import assert from "node:assert/strict";
import test from "node:test";

import { SOUND_RECIPES, type SoundRecipe, type SoundRecipeId } from "./recipes.js";
import { searchSampleIndex, toSampleEntry } from "../samplemeta.js";

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

test("guitar recipes find common filename spellings for their sample flavor", () => {
  const files = [
    ["guitar_acoustic", "/Library/Acoustic_Nylon_Guitar_C3.wav"],
    ["guitar_clean", "/Library/Clean_Electric_Guitar_C3.wav"],
    ["guitar_muted", "/Library/Guitar_Mute_C3.wav"],
    ["guitar_overdrive", "/Library/Guitar_Distorted_C3.wav"],
  ] as const;
  const index = files.map(([, filePath]) => toSampleEntry(filePath));

  for (const [id, filePath] of files) {
    const recipe = SOUND_RECIPES[id];
    const hits = recipe.sampleQueries.flatMap((query) => searchSampleIndex(index, query).results);
    assert.ok(hits.includes(filePath), `${id} did not query-match ${filePath}`);
  }
});

test("clean Guitar rejects samples labeled as distorted even in a clean folder", async () => {
  const module = await import("../tools/soundrecipes.js") as unknown as {
    isSuitableSample?: (recipe: SoundRecipe, filePath: string) => boolean;
  };
  assert.equal(typeof module.isSuitableSample, "function");
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_clean, "/Library/Clean/Electric_Guitar_Distorted_C3.wav"), false);
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_clean, "/Library/Clean_Electric_Guitar_C3.wav"), true);
});

test("overdrive and muted Guitar evidence reject generic Rock and Funk samples", async () => {
  const module = await import("../tools/soundrecipes.js") as unknown as {
    isSuitableSample?: (recipe: SoundRecipe, filePath: string) => boolean;
  };
  assert.equal(typeof module.isSuitableSample, "function");
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_overdrive, "/Library/Rock_Guitar_C3.wav"), false);
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_overdrive, "/Library/Guitar_Distorted_C3.wav"), true);
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_muted, "/Library/Funk_Guitar_C3.wav"), false);
  assert.equal(module.isSuitableSample!(SOUND_RECIPES.guitar_muted, "/Library/Guitar_Mute_C3.wav"), true);
});
