import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");
const start = html.indexOf("// ----- effort control -----");
const end = html.indexOf("const yoloToggle", start);
class Element {
  dataset: Record<string, string> = {};
  value = ""; min = ""; max = ""; textContent = ""; disabled = false;
  style = { display: "", setProperty() {} };
  classList = { toggle() {}, add() {}, remove() {}, contains() { return true; } };
  listeners: Record<string, () => void> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  addEventListener(k: string, fn: () => void) { this.listeners[k] = fn; }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); }
  set innerHTML(_: string) { this.children = []; }
  focus() {}
}
function fixture(provider = "codex", baseUrl = "", model = "") {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const saved = new Map<string, string>();
  const context = {
    document: { getElementById: el, createElement: () => new Element(), addEventListener() {} },
    localStorage: { getItem: (k: string) => saved.get(k), setItem: (k: string, v: string) => saved.set(k, v) },
    currentProvider: provider, cfgInputs: { baseUrl: { value: baseUrl }, model: { value: model } },
    refreshSpeed() {}, renderModelSummary() {}, t: (key: string) => key, URL,
  };
  runInNewContext(html.slice(start, end), context);
  return { el, run: (s: string) => runInNewContext(s, context), saved };
}

test("effort slider keeps automatic selection until moved, and persists explicit levels", () => {
  const f = fixture();
  assert.equal(f.run("selectedEffort"), "");
  const slider = f.el("effortSlider");
  assert.equal(String(slider.max), "4");
  slider.value = "3";
  slider.listeners.input();
  assert.equal(f.run("selectedEffort"), "high");
  assert.ok([...f.saved.values()].includes("high"));
  f.el("effortAutoBtn").listeners.click();
  assert.equal(f.run("selectedEffort"), "");
});

test("effort slider follows custom model levels rather than inventing five steps", () => {
  const f = fixture("custom", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-250615");
  assert.equal(f.run("selectedEffort"), "off");
  const slider = f.el("effortSlider");
  assert.equal(String(slider.max), "1");
  slider.value = "1";
  slider.listeners.input();
  assert.equal(f.run("selectedEffort"), "on");
});
