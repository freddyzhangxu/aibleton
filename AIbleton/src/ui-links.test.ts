import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");
const start = html.indexOf("const SAFE_LINK_PROTOCOLS =");
const end = html.indexOf("function splitMarkdownTableRow", start);
assert.ok(start >= 0 && end > start, "inline reply renderer exists");

class Element {
  children: Array<Element | { text: string }> = [];
  handlers = new Map<string, (event: { preventDefault(): void }) => void>();
  href = "";
  target = "";
  rel = "";
  constructor(readonly tag: string) {}
  appendChild(child: Element | { text: string }) { this.children.push(child); }
  addEventListener(type: string, handler: (event: { preventDefault(): void }) => void) {
    this.handlers.set(type, handler);
  }
  get textContent(): string {
    return this.children.map((child) => child instanceof Element ? child.textContent : child.text).join("");
  }
  set textContent(value: string) { this.children = [{ text: value }]; }
}

function renderInline(source: string) {
  const requests: Array<{ path: string; options: { method: string; headers: Record<string, string>; body: string } }> = [];
  const document = {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => ({ text }),
  };
  const context = vm.createContext({ document, URL, fetch: (path: string, options: { method: string; headers: Record<string, string>; body: string }) => {
    requests.push({ path, options });
    return Promise.resolve({ ok: true });
  } });
  const render = vm.runInContext(`${html.slice(start, end)}\nappendInlineMarkdown`, context) as
    (target: Element, source: string) => void;
  const root = new Element("div");
  render(root, source);
  return { root, requests };
}

test("assistant replies turn plain web addresses into clickable links", () => {
  const { root } = renderInline("See https://example.com/guide?part=1, then continue.");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.href, "https://example.com/guide?part=1");
  assert.equal(link.textContent, "https://example.com/guide?part=1");
  assert.equal(root.textContent, "See https://example.com/guide?part=1, then continue.");
});

test("clicking a rendered answer link asks the host to open its URL", () => {
  const { root, requests } = renderInline("[Guide](https://example.com/guide)");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  let prevented = false;
  link.handlers.get("click")?.({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    path: "/api/link/open",
    options: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/guide" }) },
  }]);
});

test("a plain URL has one anchor and opens only once", () => {
  const { root, requests } = renderInline("https://example.com/guide");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.children.some((child) => child instanceof Element && child.tag === "a"), false);
  link.handlers.get("click")?.({ preventDefault() {} });
  assert.equal(requests.length, 1);
});

test("unsafe Markdown URLs and inline code never become links", () => {
  const { root } = renderInline("[run](javascript:alert) `https://example.com/code`");
  assert.equal(root.children.some((child) => child instanceof Element && child.tag === "a"), false);
});
