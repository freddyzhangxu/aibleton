import assert from "node:assert/strict";
import test from "node:test";
import { deleteAuthorizationFor, deleteToolIsAuthorized } from "./deleteauth.js";

test("authorizes explicitly named deletion kinds only", () => {
  const auth = deleteAuthorizationFor("删除 Bass 轨道，并 remove the old scene");
  assert.equal(deleteToolIsAuthorized("delete_track", auth), true);
  assert.equal(deleteToolIsAuthorized("delete_scene", auth), true);
  assert.equal(deleteToolIsAuthorized("delete_device", auth), false);
});

test("requires a delete verb and a specific object kind", () => {
  assert.equal(deleteAuthorizationFor("清理一下工程").size, 0);
  assert.equal(deleteAuthorizationFor("删除没用的东西").size, 0);
  assert.equal(deleteAuthorizationFor("remove unused things").size, 0);
});

test("does not authorize negated deletion requests", () => {
  assert.equal(deleteAuthorizationFor("不要删除 Bass 轨道").size, 0);
  assert.equal(deleteAuthorizationFor("don't delete the scene").size, 0);
});

test("recognizes arrangement and session clip requests separately", () => {
  const arrangement = deleteAuthorizationFor("删除第 2 个编排区片段");
  assert.equal(deleteToolIsAuthorized("delete_arrangement_clip", arrangement), true);
  assert.equal(deleteToolIsAuthorized("delete_session_clip", arrangement), false);
  const session = deleteAuthorizationFor("remove this Session clip");
  assert.equal(deleteToolIsAuthorized("delete_session_clip", session), true);
});

test("recognizes the Chinese generic device noun", () => {
  assert.equal(deleteToolIsAuthorized("delete_device", deleteAuthorizationFor("删除这个设备")), true);
  assert.equal(deleteToolIsAuthorized("delete_drum_pad_device", deleteAuthorizationFor("删除这个设备")), true);
});

test("authorizes named device replacement in English and Chinese", () => {
  const english = deleteAuthorizationFor(
    "Replace the Operator devices on Track 1 and Track 2 with piano samples.",
  );
  assert.equal(deleteToolIsAuthorized("delete_device", english), true);
  assert.equal(deleteToolIsAuthorized("replace_device", english), true);
  assert.equal(deleteToolIsAuthorized("delete_track", english), false);
  assert.equal(deleteToolIsAuthorized("delete_arrangement_clip", english), false);

  const chinese = deleteAuthorizationFor("把 Track 1 和 Track 2 的 Operator 换成钢琴采样。");
  assert.equal(deleteToolIsAuthorized("delete_device", chinese), true);
  assert.equal(deleteToolIsAuthorized("replace_device", chinese), true);
  assert.equal(deleteToolIsAuthorized("delete_scene", chinese), false);
});

test("does not infer device deletion from vague or negated replacement requests", () => {
  for (const text of [
    "Use piano samples.",
    "Make the lead a piano.",
    "把 lead 改成钢琴。",
    "不要替换 Operator。",
    "Don't replace the Operator device with a piano sample.",
  ]) {
    assert.equal(deleteToolIsAuthorized("delete_device", deleteAuthorizationFor(text)), false, text);
  }
});
