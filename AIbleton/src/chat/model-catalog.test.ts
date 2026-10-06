import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerCatalog } from "./testconn.js";

test("Gemini suggests general generateContent models while preserving specialty models in the full catalog", () => {
  const result = pickerCatalog("gemini", JSON.stringify({ models: [
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-pro-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-live", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-3.5-transcribe", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-omni-flash-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-flash-latest" },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
  ] }));
  assert.equal(result.models.length, 8);
  assert.deepEqual(new Set(result.suggestedModels), new Set([
    "gemini-2.5-flash", "gemini-3.1-pro-preview", "gemini-flash-latest",
  ]));
  assert.deepEqual(result.previewModels, ["gemini-3.1-pro-preview", "gemini-2.5-flash-preview-tts", "gemini-omni-flash-preview"]);
});

test("Custom hides known specialties and explicit lack of tools without dropping opaque model aliases", () => {
  const result = pickerCatalog("custom", JSON.stringify({ data: [
    { id: "relay-alias" },
    { id: "qwen-vl", architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] },
    { id: "no-tools", supported_parameters: ["temperature"] },
    { id: "doubao-embedding-text-240515" },
    { id: "bge-reranker-v2" },
    { id: "whisper-1" },
    { id: "seedream-4" },
    { id: "image-only-alias", architecture: { output_modalities: ["image"] } },
    { id: "relay-alias" }, { id: 123 }, {},
  ] }));
  assert.deepEqual(result.suggestedModels, ["qwen-vl", "relay-alias"]);
  assert.equal(result.models.length, 8);
  assert.ok(result.models.includes("seedream-4"));
});

test("suggestions prefer newer general Gemini versions over older versions", () => {
  const result = pickerCatalog("gemini", JSON.stringify({ models: [
    { name: "models/gemini-2.5-flash" }, { name: "models/gemini-3.1-flash" },
  ] }));
  assert.deepEqual(result.suggestedModels, ["gemini-3.1-flash", "gemini-2.5-flash"]);
});

test("malformed catalogs are safe and never suggest invalid ids", () => {
  for (const body of ["null", "not-json", "{}", '{"data":[null,{"id":{}},{"id":" "}]}']) {
    assert.deepEqual(pickerCatalog("custom", body).models, []);
  }
});
