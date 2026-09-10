/**
 * evaluate.test.ts — key criteria: key_unchanged judged against Live's
 * declared scale when Scale Mode is on (user-set ground truth, immune to
 * keyBest wobble), and in_key / off_key_lte reading the same off-scale
 * ratio the OFF_KEY issue fires on. Also covers GoalView's liveScale /
 * offKeyRatio projection and input normalization for the new kinds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OFF_KEY_THRESHOLD } from "../../analysis/interpret.js";
import { buildMusicState } from "../../musicstate/builder.js";
import { midiClip, note, snapshot, track } from "../../music/features/__tests__/fixtures.js";
import { evaluateGoal } from "../evaluate.js";
import { normalizeGoal } from "../types.js";
import { buildGoalView, type GoalView } from "../view.js";

const SCALE_OFF = { mode: false, root: 0, name: "", intervals: [] };
const C_MAJOR = { mode: true, root: 0, name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] };

function view(overrides: Partial<GoalView> = {}): GoalView {
  return {
    tempo: 120,
    keyBest: "C major",
    liveScale: SCALE_OFF,
    trackCount: 0,
    tracks: [],
    sections: [],
    songRoles: new Set(),
    ...overrides,
  };
}

function goalWith(criterion: Parameters<typeof evaluateGoal>[0]["successCriteria"][number]) {
  return {
    type: "edit" as const,
    objective: "test",
    constraints: [],
    successCriteria: [criterion],
  };
}

// ---------------------------------------------------------------------------
// key_unchanged
// ---------------------------------------------------------------------------

test("key_unchanged: Scale Mode on both sides — declared scale judges, keyBest wobble ignored", () => {
  const before = view({ liveScale: C_MAJOR, keyBest: "C major" });
  // Sparse material flipped the DETECTED key; the user never touched Live's scale.
  const after = view({ liveScale: C_MAJOR, keyBest: "A minor" });
  const ev = evaluateGoal(goalWith({ kind: "key_unchanged" }), before, after);
  assert.equal(ev.met, true);
  assert.equal(ev.checks[0].expected, "调式保持 C Major");
});

test("key_unchanged: Scale Mode on — root change fails", () => {
  const before = view({ liveScale: C_MAJOR });
  const after = view({ liveScale: { ...C_MAJOR, root: 9, name: "Major" }, keyBest: "C major" });
  const ev = evaluateGoal(goalWith({ kind: "key_unchanged" }), before, after);
  assert.equal(ev.met, false);
  assert.equal(ev.checks[0].actual, "A Major");
});

test("key_unchanged: Scale Mode on — same root, different intervals (major→minor) fails", () => {
  const before = view({ liveScale: C_MAJOR });
  const after = view({
    liveScale: { mode: true, root: 0, name: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
  });
  const ev = evaluateGoal(goalWith({ kind: "key_unchanged" }), before, after);
  assert.equal(ev.met, false);
});

test("key_unchanged: Scale Mode off — detected keyBest judges (legacy behavior)", () => {
  const before = view({ keyBest: "F# minor" });
  assert.equal(
    evaluateGoal(goalWith({ kind: "key_unchanged" }), before, view({ keyBest: "F# minor" })).met,
    true,
  );
  assert.equal(
    evaluateGoal(goalWith({ kind: "key_unchanged" }), before, view({ keyBest: "G major" })).met,
    false,
  );
});

test("key_unchanged: mixed mode (off→on) falls back to keyBest — the toggle isn't a key change", () => {
  const before = view({ liveScale: SCALE_OFF, keyBest: "C major" });
  const after = view({ liveScale: C_MAJOR, keyBest: "C major" });
  const ev = evaluateGoal(goalWith({ kind: "key_unchanged" }), before, after);
  assert.equal(ev.met, true);
});

// ---------------------------------------------------------------------------
// in_key / off_key_lte
// ---------------------------------------------------------------------------

test("in_key: passes at/below the OFF_KEY threshold, fails above", () => {
  const inKey = view({ offKeyRatio: OFF_KEY_THRESHOLD - 0.01, offKeyScale: "Live scale C Major" });
  assert.equal(evaluateGoal(goalWith({ kind: "in_key" }), view(), inKey).met, true);

  const offKey = view({ offKeyRatio: OFF_KEY_THRESHOLD + 0.05, offKeyScale: "Live scale C Major" });
  const ev = evaluateGoal(goalWith({ kind: "in_key" }), view(), offKey);
  assert.equal(ev.met, false);
  assert.match(ev.checks[0].expected, /≤ 15%/);
  assert.match(ev.checks[0].actual ?? "", /20%/);
});

test("in_key: unmeasurable ratio FAILS with the reason spelled out (unknown ≠ clean)", () => {
  const ev = evaluateGoal(goalWith({ kind: "in_key" }), view(), view());
  assert.equal(ev.met, false);
  assert.match(ev.checks[0].actual ?? "", /无法测量/);
});

test("off_key_lte: custom bound, inclusive at the boundary", () => {
  const after = view({ offKeyRatio: 0.05, offKeyScale: "detected key C major" });
  assert.equal(
    evaluateGoal(goalWith({ kind: "off_key_lte", pct: 0.05 }), view(), after).met,
    true,
  );
  assert.equal(
    evaluateGoal(goalWith({ kind: "off_key_lte", pct: 0.04 }), view(), after).met,
    false,
  );
});

test("off_key_lte: pct 0 is a valid strict bound (zero off-key notes)", () => {
  const clean = view({ offKeyRatio: 0, offKeyScale: "Live scale C Major" });
  assert.equal(evaluateGoal(goalWith({ kind: "off_key_lte", pct: 0 }), view(), clean).met, true);
  const dirty = view({ offKeyRatio: 0.01, offKeyScale: "Live scale C Major" });
  assert.equal(evaluateGoal(goalWith({ kind: "off_key_lte", pct: 0 }), view(), dirty).met, false);
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("normalizeGoal: in_key takes no params; off_key_lte validates pct", () => {
  const ok = normalizeGoal({
    type: "fix",
    objective: "修走音",
    successCriteria: [{ kind: "in_key" }, { kind: "off_key_lte", pct: 0.1 }],
  });
  assert.deepEqual(ok.goal?.successCriteria, [
    { kind: "in_key" },
    { kind: "off_key_lte", pct: 0.1 },
  ]);

  for (const bad of [{ kind: "off_key_lte" }, { kind: "off_key_lte", pct: 1 }, { kind: "off_key_lte", pct: -0.5 }]) {
    const norm = normalizeGoal({ type: "fix", objective: "x", successCriteria: [bad] });
    assert.equal(norm.goal, null, JSON.stringify(bad));
    assert.equal(norm.warnings.length > 0, true);
  }
});

// ---------------------------------------------------------------------------
// GoalView projection (buildGoalView over a real MusicState)
// ---------------------------------------------------------------------------

/** 16 beats in-scale + 4 beats out = 20 weighted beats, 20% off-key. */
function offKeyState(liveScale: GoalView["liveScale"]) {
  const inScale = Array.from({ length: 16 }, (_, i) => note(60, i, 1));
  const outScale = Array.from({ length: 4 }, (_, i) => note(61, 16 + i, 1));
  return buildMusicState(
    snapshot(
      [track(0, "Keys", "midi", [midiClip("riff", [...inScale, ...outScale], { duration: 20, loopEnd: 20 })])],
      { liveScale },
    ),
  );
}

test("buildGoalView: projects liveScale and the measured offKeyRatio", () => {
  const v = buildGoalView(offKeyState(C_MAJOR));
  assert.deepEqual(v.liveScale, C_MAJOR);
  assert.equal(v.offKeyRatio !== undefined, true);
  assert.ok(Math.abs((v.offKeyRatio ?? 0) - 0.2) < 1e-9, `ratio=${v.offKeyRatio}`);
  assert.match(v.offKeyScale ?? "", /Live scale C Major/);
});

test("buildGoalView: no usable scale → offKeyRatio stays undefined (unknowable, not zero)", () => {
  // Scale Mode off and 2 unique pitch classes — key undetectable.
  const v = buildGoalView(offKeyState(SCALE_OFF));
  assert.equal(v.liveScale.mode, false);
  assert.equal(v.offKeyRatio, undefined);
});
