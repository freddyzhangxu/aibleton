/**
 * gen-criteria.test.ts — the gen_* judges (PR18): gen_metric_gte as an
 * absolute bar over the latest generation, gen_improved_vs_prev as a
 * longitudinal improvement check against the goal-declaration baseline.
 * Both fail closed: no record, unanalyzable artifact, or no NEW generation
 * this turn is a failed check, never a silent pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AudioFeatures } from "../../dsp.js";
import { evaluateGoal } from "../evaluate.js";
import { goalNeedsGenlog, normalizeGoal, type Criterion } from "../types.js";
import type { GoalGenMeasure, GoalView } from "../view.js";

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    durationSec: 8,
    sampleRate: 44100,
    channels: 2,
    rmsDb: -18,
    peakDb: -3,
    crestDb: 5,
    loudnessDb: -20,
    dynamicRangeDb: 9,
    spectralCentroidHz: 2500,
    bands: { sub: 0.1, bass: 0.2, lowMid: 0.2, mid: 0.2, highMid: 0.2, high: 0.1 },
    transientDensity: 4,
    ...over,
  };
}

function gen(id: string, f?: AudioFeatures, featuresError?: string): GoalGenMeasure {
  return {
    id,
    provider: "stable-audio",
    ...(f ? { features: f } : {}),
    ...(featuresError ? { featuresError } : {}),
  };
}

function view(overrides: Partial<GoalView> = {}): GoalView {
  return {
    tempo: 120,
    keyBest: "C major",
    liveScale: { mode: false, root: 0, name: "", intervals: [] },
    trackCount: 0,
    tracks: [],
    sections: [],
    songRoles: new Set(),
    ...overrides,
  };
}

function goalWith(criterion: Criterion) {
  return { type: "sound_design" as const, objective: "test", constraints: [], successCriteria: [criterion] };
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test("normalize: gen_metric_gte scalar and band forms accepted", () => {
  const a = normalizeGoal({
    type: "sound_design",
    objective: "x",
    successCriteria: [{ kind: "gen_metric_gte", metric: "crestDb", value: 6 }],
  });
  assert.deepEqual(a.goal?.successCriteria[0], { kind: "gen_metric_gte", metric: "crestDb", value: 6 });

  const b = normalizeGoal({
    type: "sound_design",
    objective: "x",
    successCriteria: [{ kind: "gen_metric_gte", metric: "band", band: "highMid", value: 0.3 }],
  });
  assert.deepEqual(b.goal?.successCriteria[0], {
    kind: "gen_metric_gte",
    metric: "band",
    band: "highMid",
    value: 0.3,
  });
});

test("normalize: gen_improved_vs_prev accepted; bad metric/band/direction/min_delta dropped with warnings", () => {
  const ok = normalizeGoal({
    type: "sound_design",
    objective: "x",
    successCriteria: [
      { kind: "gen_improved_vs_prev", metric: "spectralCentroidHz", direction: "up", min_delta: 500 },
    ],
  });
  assert.deepEqual(ok.goal?.successCriteria[0], {
    kind: "gen_improved_vs_prev",
    metric: "spectralCentroidHz",
    direction: "up",
    min_delta: 500,
  });

  for (const raw of [
    { kind: "gen_metric_gte", metric: "nonsense", value: 1 },
    { kind: "gen_metric_gte", metric: "band", value: 0.3 }, // band name missing
    { kind: "gen_metric_gte", metric: "crestDb" }, // value missing
    { kind: "gen_improved_vs_prev", metric: "crestDb", direction: "sideways", min_delta: 1 },
    { kind: "gen_improved_vs_prev", metric: "crestDb", direction: "up", min_delta: 0 },
  ]) {
    const n = normalizeGoal({ type: "sound_design", objective: "x", successCriteria: [raw] });
    assert.equal(n.goal, null, JSON.stringify(raw));
    assert.ok(n.warnings.length > 0);
  }
});

test("goalNeedsGenlog only for gen_* kinds", () => {
  assert.equal(
    goalNeedsGenlog({ type: "edit", objective: "", constraints: [], successCriteria: [{ kind: "gen_metric_gte", metric: "crestDb", value: 6 }] }),
    true,
  );
  assert.equal(
    goalNeedsGenlog({ type: "edit", objective: "", constraints: [], successCriteria: [{ kind: "tempo_unchanged" }] }),
    false,
  );
});

// ---------------------------------------------------------------------------
// gen_metric_gte
// ---------------------------------------------------------------------------

test("gen_metric_gte: threshold met / missed on a scalar metric", () => {
  const after = view({ latestGeneration: gen("g2", features({ crestDb: 6.5 })) });
  const ev = evaluateGoal(goalWith({ kind: "gen_metric_gte", metric: "crestDb", value: 6 }), view(), after);
  assert.equal(ev.met, true);

  const low = view({ latestGeneration: gen("g2", features({ crestDb: 4 })) });
  const ev2 = evaluateGoal(goalWith({ kind: "gen_metric_gte", metric: "crestDb", value: 6 }), view(), low);
  assert.equal(ev2.met, false);
  assert.match(ev2.criteriaIssues[0], /4/);
});

test("gen_metric_gte: band metric reads the named band's energy share", () => {
  const after = view({ latestGeneration: gen("g2", features()) });
  const ev = evaluateGoal(
    goalWith({ kind: "gen_metric_gte", metric: "band", band: "highMid", value: 0.15 }),
    view(),
    after,
  );
  assert.equal(ev.met, true); // highMid = 0.2
});

test("gen_metric_gte fails closed: no registry record, or unanalyzable artifact", () => {
  const c: Criterion = { kind: "gen_metric_gte", metric: "crestDb", value: 6 };
  const noGen = evaluateGoal(goalWith(c), view(), view());
  assert.equal(noGen.met, false);
  assert.match(noGen.criteriaIssues[0], /genlog 为空/);

  const mp3 = view({ latestGeneration: gen("g2", undefined, 'unsupported format ".mp3" (WAV/AIFF only)') });
  const ev = evaluateGoal(goalWith(c), view(), mp3);
  assert.equal(ev.met, false);
  assert.match(ev.criteriaIssues[0], /无法分析/);
});

// ---------------------------------------------------------------------------
// gen_improved_vs_prev
// ---------------------------------------------------------------------------

test("gen_improved_vs_prev: up-direction improvement passes, shortfall fails", () => {
  const c: Criterion = {
    kind: "gen_improved_vs_prev",
    metric: "spectralCentroidHz",
    direction: "up",
    min_delta: 500,
  };
  const before = view({ latestGeneration: gen("g1", features({ spectralCentroidHz: 2500 })) });
  const pass = view({ latestGeneration: gen("g2", features({ spectralCentroidHz: 3100 })) });
  assert.equal(evaluateGoal(goalWith(c), before, pass).met, true);

  const short = view({ latestGeneration: gen("g2", features({ spectralCentroidHz: 2700 })) });
  const ev = evaluateGoal(goalWith(c), before, short);
  assert.equal(ev.met, false);
  assert.match(ev.criteriaIssues[0], /Δ 200/);
});

test("gen_improved_vs_prev: down-direction judged on the negative delta", () => {
  const c: Criterion = { kind: "gen_improved_vs_prev", metric: "crestDb", direction: "down", min_delta: 2 };
  const before = view({ latestGeneration: gen("g1", features({ crestDb: 12 })) });
  const after = view({ latestGeneration: gen("g2", features({ crestDb: 9 })) });
  assert.equal(evaluateGoal(goalWith(c), before, after).met, true);
});

test("gen_improved_vs_prev fails closed: no baseline record, no NEW generation, or either side unanalyzable", () => {
  const c: Criterion = { kind: "gen_improved_vs_prev", metric: "crestDb", direction: "up", min_delta: 1 };

  // Registry was empty at goal declaration.
  const noBase = evaluateGoal(goalWith(c), view(), view({ latestGeneration: gen("g2", features()) }));
  assert.equal(noBase.met, false);
  assert.match(noBase.criteriaIssues[0], /genlog 为空/);

  // Same record on both sides — nothing was generated this turn.
  const same = view({ latestGeneration: gen("g1", features()) });
  const noNew = evaluateGoal(goalWith(c), same, same);
  assert.equal(noNew.met, false);
  assert.match(noNew.criteriaIssues[0], /没有新生成/);

  // The new artifact is an undecodable mp3 — unknown, never "improved by 0".
  const before = view({ latestGeneration: gen("g1", features()) });
  const mp3 = view({ latestGeneration: gen("g2", undefined, 'unsupported format ".mp3" (WAV/AIFF only)') });
  const ev = evaluateGoal(goalWith(c), before, mp3);
  assert.equal(ev.met, false);
  assert.match(ev.criteriaIssues[0], /无法分析/);
});

test("gen_improved_vs_prev: band metric with direction", () => {
  const c: Criterion = { kind: "gen_improved_vs_prev", metric: "band", band: "sub", direction: "up", min_delta: 0.05 };
  const before = view({
    latestGeneration: gen("g1", features({ bands: { sub: 0.1, bass: 0.2, lowMid: 0.2, mid: 0.2, highMid: 0.2, high: 0.1 } })),
  });
  const after = view({
    latestGeneration: gen("g2", features({ bands: { sub: 0.2, bass: 0.2, lowMid: 0.2, mid: 0.2, highMid: 0.1, high: 0.1 } })),
  });
  assert.equal(evaluateGoal(goalWith(c), before, after).met, true);
});
