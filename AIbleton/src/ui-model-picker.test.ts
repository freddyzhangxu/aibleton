import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext, type Context } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");
const start = html.indexOf("function closeModelPop()");
const end = html.indexOf("modelBtn.addEventListener('click'", start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

class Element {
  children: Element[] = [];
  className = "";
  textContent = "";
  value = "";
  placeholder = "";
  type = "";
  title = "";
  disabled = false;
  dataset: Record<string, string> = {};
  events: string[] = [];
  listeners: Record<string, (event: { stopPropagation(): void }) => unknown> = {};
  classes = new Set<string>();
  classList = { add: (value: string) => this.classes.add(value), contains: (value: string) => this.classes.has(value) };
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); }
  addEventListener(name: string, handler: (event: { stopPropagation(): void }) => unknown) { this.listeners[name] = handler; }
  setAttribute(_name: string, _value: string) {}
  focus() {}
  setSelectionRange(_start: number, _end: number) {}
  dispatchEvent(event: Event) { this.events.push(event.type); return true; }
}

function render(models: string[], detail = "", options: Record<string, unknown> = {}) {
  const modelPop = new Element();
  const model = new Element();
  const data = { models, detail, ...options };
  const context: Context = {
    modelPop, cfgInputs: { model }, Event,
    currentProvider: "custom", modelQuery: "", modelShowAll: false,
    modelListCache: { custom: data }, modelPreferenceWrites: Promise.resolve(),
    currentModelId: () => "current-model",
    document: { createElement: () => new Element() },
    t: (key: string) => key,
    fetch: async () => ({ ok: true, json: async () => ({ preferences: { favorites: [], recent: ["other-model"] } }) }),
    data,
  };
  runInNewContext(source + "\nrenderModelPop(data);", context);
  return { modelPop, model, context };
}

const click = { stopPropagation() {} };
const rows = (pop: Element) => pop.children.filter((row) => row.className === "model-row");
const rowIds = (pop: Element) => rows(pop).map((row) => row.children[1].textContent);
function find(pop: Element, name: string): Element | undefined {
  if (pop.className === name) return pop;
  for (const child of pop.children) { const match = find(child, name); if (match) return match; }
}

test("empty catalog stays silent — no alarming failure note behind the current model", () => {
  const { modelPop } = render([], "HTTP 404");
  const note = modelPop.children.find((row) => row.className.includes("model-note"));
  assert.ok(!note, "endpoints without a catalog are not an error — no note shown");
  assert.ok(modelPop.children.some((row) => row.children[1]?.textContent === "current-model"));
});

test("partial catalog keeps the failure note — models are listed but incomplete", () => {
  const { modelPop } = render(["chat"], "catalog pagination incomplete", { partial: true });
  const note = modelPop.children.find((row) => row.className.includes("model-note"));
  assert.ok(note, "partial catalog must say so");
  assert.match(note.textContent, /modelListFail · catalog pagination incomplete/);
});

test("compact picker shows at most eight models with current, favorites and recent first", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `chat-${i}`);
  const { modelPop } = render([...ids, "image-only"], "", {
    suggestedModels: ids, favorites: ["chat-9"], recent: ["chat-8"],
  });
  assert.deepEqual(rowIds(modelPop).slice(0, 3), ["current-model", "chat-9", "chat-8"]);
  assert.equal(rowIds(modelPop).length, 8);
  assert.ok(!rowIds(modelPop).includes("image-only"));
});

test("all models and search both expose models excluded from the compact view", () => {
  const { modelPop } = render(["chat", "image-only"], "", { suggestedModels: ["chat"] });
  const all = find(modelPop, "model-view-all");
  assert.ok(all, "full catalog control exists");
  all.listeners.click(click);
  assert.ok(rowIds(modelPop).includes("image-only"));
  const search = find(modelPop, "model-search");
  assert.ok(search, "search exists");
  search.value = "IMAGE";
  search.listeners.input(click);
  assert.deepEqual(rowIds(modelPop), ["current-model", "image-only"]);
});

test("a search with no matches keeps current model and reports no matches", () => {
  const { modelPop } = render(["chat"], "", { suggestedModels: ["chat"] });
  const search = find(modelPop, "model-search");
  assert.ok(search);
  search.value = "no-such-model";
  search.listeners.input(click);
  assert.deepEqual(rowIds(modelPop), ["current-model"]);
  assert.ok(modelPop.children.some((row) => row.textContent === "modelNoMatch"));
});

test("favoriting persists a scoped preference without selecting the model or closing the popup", async () => {
  const { modelPop, model, context } = render(["other-model"], "", { scope: "custom:https://relay.example/v1" });
  const requests: unknown[] = [];
  context.fetch = async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ preferences: { favorites: ["other-model"], recent: [] } }) };
  };
  const other = rows(modelPop).find((row) => row.children[1].textContent === "other-model");
  assert.ok(other);
  const star = find(other, "model-favorite");
  assert.ok(star, "favorite control exists");
  await star.listeners.click(click);
  await context.modelPreferenceWrites;
  assert.deepEqual(requests, [{ url: "/api/model-preferences", body: {
    provider: "custom", scope: "custom:https://relay.example/v1", model: "other-model", favorite: true,
  } }]);
  assert.equal(model.value, "");
  assert.deepEqual(model.events, []);
  assert.ok(!modelPop.classes.has("hidden"));
});

test("a stale provider menu cannot select or save a model after another window switches providers", () => {
  const { modelPop, model, context } = render(["other-model"], "", { scope: "custom:https://relay.example/v1" });
  const other = rows(modelPop).find((row) => row.children[1].textContent === "other-model");
  assert.ok(other);
  context.currentProvider = "gemini";
  other.listeners.click(click);
  assert.equal(model.value, "");
  assert.deepEqual(model.events, []);
  assert.ok(modelPop.classes.has("hidden"));
});

test("cross-window provider changes close the picker, invalidate catalogs and clear the old health model", () => {
  const providerStart = html.indexOf("function setCurrentProvider(");
  const providerSource = providerStart < 0 ? "" : html.slice(providerStart, html.indexOf("function updateModelName(", providerStart));
  const storageStart = html.indexOf("window.addEventListener('storage'");
  const storageSource = html.slice(storageStart, html.indexOf("function applyLang()", storageStart));
  const modelPop = new Element();
  let listener: (event: { key: string; newValue: string }) => void = () => {};
  const context: Context = {
    window: { addEventListener: (_type: string, callback: typeof listener) => { listener = callback; } },
    modelPop, currentProvider: "custom", healthModel: "old-provider-model", modelCatalogRequest: 1,
    PROVIDERS: { custom: { name: "Custom" }, gemini: { name: "Gemini" } }, providerVal: new Element(),
    loadProviderFields() {}, renderProviders() {}, renderEfforts() {}, refreshHealth() {}, renderConnOut() {},
  };
  runInNewContext(providerSource + source + storageSource, context);
  listener({ key: "ai.provider", newValue: "gemini" });
  assert.equal(context.currentProvider, "gemini");
  assert.ok(modelPop.classes.has("hidden"));
  assert.equal(context.healthModel, "");
  assert.ok(context.modelCatalogRequest > 1);
});

test("selecting a discovered model updates the persisted settings field and closes the picker", () => {
  const { modelPop, model } = render(["current-model", "other-model"]);
  const rows = modelPop.children.filter((row) => row.className === "model-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, "✓");
  rows[1].listeners.click({ stopPropagation() {} });
  assert.equal(model.value, "other-model");
  assert.deepEqual(model.events, ["input", "change"]);
  assert.ok(modelPop.classes.has("hidden"));
});
