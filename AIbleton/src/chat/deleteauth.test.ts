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
