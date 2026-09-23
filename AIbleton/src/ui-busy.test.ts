import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const interfaceHtml = readFileSync(new URL("../ui/interface.html", import.meta.url), "utf8");
const sendStart = interfaceHtml.indexOf("async function send() {");
const sendEnd = interfaceHtml.indexOf("sendBtn.addEventListener('click'", sendStart);
const sendSource = interfaceHtml.slice(sendStart, sendEnd);

test("a busy send restores the draft without clearing the active stop state", () => {
  assert.ok(sendStart >= 0, "send handler is present");
  assert.ok(sendEnd > sendStart, "send handler boundary is present");

  const busyStart = sendSource.indexOf("if (res.status === 409)");
  const busyEnd = sendSource.indexOf("throw new Error", busyStart);
  assert.ok(busyStart >= 0, "busy response branch is present");
  assert.ok(busyEnd > busyStart, "busy response branch has a following error path");

  const busyBranch = sendSource.slice(busyStart, busyEnd);
  assert.match(busyBranch, /userMsg\.remove\(\)/);
  assert.match(busyBranch, /input\.value = text/);
  assert.match(busyBranch, /localStorage\.setItem\(DRAFT_KEY, text\)/);
  assert.match(busyBranch, /pendingAttachments\.unshift\(\.\.\.attachments\)/);
  assert.match(busyBranch, /return;/);
  assert.doesNotMatch(busyBranch, /setBusy\(false\)/);
});
