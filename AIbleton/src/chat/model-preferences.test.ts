import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPreferenceScope, normalizeModelPreferences, updateModelPreferences } from "./model-preferences.js";

test("model preferences isolate providers and endpoints but normalize trailing slashes", () => {
  assert.equal(modelPreferenceScope("custom", "https://relay.example/v1/"), modelPreferenceScope("custom", "https://relay.example/v1"));
  assert.notEqual(modelPreferenceScope("custom", "https://relay.example/v1"), modelPreferenceScope("custom", "https://another.example/v1"));
  assert.notEqual(modelPreferenceScope("custom", "https://relay.example/v1"), modelPreferenceScope("codex", "https://relay.example/v1"));
});

test("favorites survive serialization, toggling never selects or changes recent models", () => {
  const prefs = updateModelPreferences({ favorites: [], recent: ["used-model"] }, "saved-model", true);
  assert.deepEqual(normalizeModelPreferences(JSON.parse(JSON.stringify(prefs))), {
    favorites: ["saved-model"], recent: ["used-model"],
  });
  assert.deepEqual(updateModelPreferences(prefs, "saved-model", false), {
    favorites: [], recent: ["used-model"],
  });
});

test("recent models move the chosen model to the front and stay bounded", () => {
  const initial = { favorites: ["favorite"], recent: ["a", "b", "c", "d", "e"] };
  const result = updateModelPreferences(initial, "c");
  assert.deepEqual(result, { favorites: ["favorite"], recent: ["c", "a", "b", "d", "e"] });
  assert.deepEqual(updateModelPreferences(result, "new").recent, ["new", "c", "a", "b", "d"]);
});

test("invalid persisted preferences are ignored and duplicate ids are removed", () => {
  assert.deepEqual(normalizeModelPreferences({ favorites: [" x ", "x", 1, null, ""], recent: "bad" }), {
    favorites: ["x"], recent: [],
  });
  assert.deepEqual(normalizeModelPreferences(null), { favorites: [], recent: [] });
});
