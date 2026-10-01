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
  handlers = new Map<string, (event: { preventDefault(): void; stopPropagation?(): void }) => void>();
  href = "";
  target = "";
  rel = "";
  constructor(readonly tag: string) {}
  appendChild(child: Element | { text: string }) { this.children.push(child); }
  addEventListener(type: string, handler: (event: { preventDefault(): void; stopPropagation?(): void }) => void) {
    this.handlers.set(type, handler);
  }
  get textContent(): string {
    return this.children.map((child) => child instanceof Element ? child.textContent : child.text).join("");
  }
  set textContent(value: string) { this.children = [{ text: value }]; }
}

function renderInline(source: string, fetchResult = { ok: true }) {
  const requests: Array<{ path: string; options: { method: string; headers: Record<string, string>; body: string } }> = [];
  const errors: string[] = [];
  const document = {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => ({ text }),
  };
  const context = vm.createContext({ document, URL, addMsg: (_cls: string, message: string) => errors.push(message),
    t: (key: string) => ({ error: "Error: ", requestFailed: "Request failed" })[key as "error" | "requestFailed"],
    fetch: (path: string, options: { method: string; headers: Record<string, string>; body: string }) => {
    requests.push({ path, options });
    return Promise.resolve(fetchResult);
  } });
  const render = vm.runInContext(`${html.slice(start, end)}\nappendInlineMarkdown`, context) as
    (target: Element, source: string) => void;
  const root = new Element("div");
  render(root, source);
  return { root, requests, errors };
}

test("assistant replies turn plain web addresses into clickable links", () => {
  const { root } = renderInline("See https://example.com/guide?part=1, then continue.");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.href, "https://example.com/guide?part=1");
  assert.equal(link.textContent, "https://example.com/guide?part=1");
  assert.equal(root.textContent, "See https://example.com/guide?part=1, then continue.");
});

test("Chinese sentence punctuation is not part of a plain URL", () => {
  const { root } = renderInline("参考（https://example.com/guide）。");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.href, "https://example.com/guide");
  assert.equal(root.textContent, "参考（https://example.com/guide）。");
});

test("Markdown links preserve balanced parentheses in the destination", () => {
  const { root } = renderInline("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.textContent, "Wiki");
  assert.equal(link.href, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.equal(root.textContent, "Wiki");
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

test("a failed system-browser request is visible beside the chat", async () => {
  const { root, errors } = renderInline("[Guide](https://example.com/guide)", { ok: false });
  const link = root.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  link.handlers.get("click")?.({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["Error: Request failed https://example.com/guide"]);
});

test("unsafe Markdown URLs and inline code never become links", () => {
  const { root } = renderInline("[run](javascript:alert) `https://example.com/code`");
  assert.equal(root.children.some((child) => child instanceof Element && child.tag === "a"), false);
});

test("web URLs in expanded tool actions can be opened without toggling the action", () => {
  const requests: Array<{ path: string; options: { body: string } }> = [];
  const document = {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => ({ text }),
  };
  const actionStart = html.indexOf("function addAction(tool, input, result)");
  const actionEnd = html.indexOf("function addSteps(actions)", actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  const context = vm.createContext({ document, URL, fetch: (path: string, options: { body: string }) => {
    requests.push({ path, options });
    return Promise.resolve({ ok: true });
  } });
  const addAction = vm.runInContext(`${html.slice(start, end)}\n${html.slice(actionStart, actionEnd)}\naddAction`, context) as
    (tool: string, input: object, result: object) => Element;
  const action = addAction("web_search", { query: "test" }, { url: "https://example.com/guide" });
  const link = action.children.find((child): child is Element => child instanceof Element && child.tag === "a");
  assert.ok(link);
  assert.equal(link.href, "https://example.com/guide");
  let stopped = false;
  link.handlers.get("click")?.({ preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(requests.length, 1);
});

test("the update-page button reports a system-browser failure", async () => {
  const start = html.indexOf("document.getElementById('updateGo').addEventListener");
  const end = html.indexOf("document.getElementById('updateDismiss').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  let click: (() => void) | undefined;
  const updateMsg = { textContent: "New version available" };
  vm.runInNewContext(html.slice(start, end), {
    document: { getElementById: () => ({ addEventListener: (_type: string, handler: () => void) => { click = handler; } }) },
    fetch: () => Promise.resolve({ ok: false }),
    updateMsg,
    t: () => "Update failed",
  });
  assert.ok(click);
  click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updateMsg.textContent, "Update failed");
});
