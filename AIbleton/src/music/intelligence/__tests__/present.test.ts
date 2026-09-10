/**
 * present.test.ts — presentGoalContext: compact JSON under budget, rounded
 * numbers, honesty preserved through serialization (missing = no data).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { MusicalObservation } from "../../reasoning/types.js";
import type { GoalMusicContext } from "../types.js";
import { CONTEXT_BUDGET, presentGoalContext } from "../present.js";
import { projectGoalContext } from "../goal.js";
import { buildDropIntel, goalOf } from "./fixtures.js";

test("renders the focused slice: target, sections, contrast, observations, song+arc", () => {
  const ctx = projectGoalContext(buildDropIntel(), goalOf({ target: { section: "Drop" } }));
  const out = presentGoalContext(ctx);
  assert.equal(out.scope, "focused");
  assert.deepEqual(out.target, { section: "Drop" });
  assert.ok(Array.isArray(out.sections));
  assert.ok(Array.isArray(out.contrasts));
  assert.ok(Array.isArray(out.observations));
  assert.ok(out.song && typeof out.song === "object");
  assert.ok(out.arc && typeof out.arc === "object");
  assert.ok(JSON.stringify(out).length <= CONTEXT_BUDGET);
});

test("numbers are rounded to 2 decimals everywhere", () => {
  const ctx = projectGoalContext(buildDropIntel(), goalOf({ target: { section: "Drop" } }));
  const json = JSON.stringify(presentGoalContext(ctx));
  assert.ok(!/\.\d{3}/.test(json), `unrounded number leaked: ${json.match(/\.\d{3}\d*/)?.[0]}`);
});

test("honesty: undefined features are omitted, never serialized as 0 or null", () => {
  const ctx = projectGoalContext(buildDropIntel(), goalOf({ target: { section: "Drop" } }));
  const sections = presentGoalContext(ctx).sections as Record<string, unknown>[];
  // MIDI-only fixture: no audio analysis ran, so band energies must be ABSENT.
  for (const row of sections) {
    assert.ok(!("low" in row), `audio feature faked: ${JSON.stringify(row)}`);
    assert.ok(!("mid" in row));
    assert.ok(!("high" in row));
  }
});

test("evidence renders as one-line metric paths with values", () => {
  const intel = buildDropIntel();
  const ctx = projectGoalContext(intel, goalOf({ target: { section: "Drop" } }));
  const out = presentGoalContext(ctx);
  const observations = out.observations as { ev?: string[] }[];
  const withEv = observations.find((o) => o.ev && o.ev.length);
  assert.ok(withEv, "no observation carried evidence");
  for (const line of withEv.ev!) {
    assert.match(line, /^(sections|tracks)\[\d+\]\.\w+(=[-\d.]+)?(→[-\d.]+)?$/);
  }
});

// ---------------------------------------------------------------------------
// Budget: a bloated context must shrink through the staged cuts.
// ---------------------------------------------------------------------------

function bloatedContext(): GoalMusicContext {
  const sections = Array.from({ length: 12 }, (_, i) => ({
    sectionId: String(i),
    name: `Section With A Rather Long Name ${i}`,
    startBeat: i * 32,
    endBeat: (i + 1) * 32,
    bars: 8,
    density: 12.3456,
    activeTrackRatio: 0.8765,
    repetition: 0.5432,
    energy: { value: 0.6789, source: "derived" as const, confidence: 0.5 },
    impact: { value: 0.4321, source: "derived" as const, confidence: 0.4 },
  }));
  const observations: MusicalObservation[] = Array.from({ length: 8 }, (_, i) => ({
    kind: "density_increase" as const,
    sectionId: String(i % 12),
    strength: 0.9 - i * 0.05,
    evidence: [
      { metric: `sections[${i % 12}].density`, value: 12.34, relatedValue: 5.67, delta: 6.67 },
    ],
  }));
  return {
    scope: "focused",
    target: { section: "Section With A Rather Long Name 3" },
    sections,
    tracks: [
      { trackId: "0", name: "Kick Drum With Long Name", muted: false, activeRatio: 0.95 },
    ],
    contrasts: [
      {
        fromSectionId: "2",
        toSectionId: "3",
        densityDelta: 6.789,
        activeTrackRatioDelta: 0.234,
        kind: "rise",
        basis: "density",
      },
    ],
    similarities: [
      {
        aSectionId: "3",
        bSectionId: "7",
        similarity: { value: 0.9123, source: "derived" as const, confidence: 0.33 },
        kind: "repeat",
      },
    ],
    arc: { energyCurve: sections.map(() => 0.5), energyCoverage: 1, kind: "flat" },
    song: {
      durationBeats: 384,
      bars: 96,
      trackCount: 8,
      midiTrackCount: 6,
      audioTrackCount: 2,
      tempo: 128,
      sectionCount: 12,
      avgDensity: 7.891,
      minEnergy: 0.123,
      maxEnergy: 0.987,
      energyRange: 0.864,
    },
    observations,
    coverage: { sections: 12, analyzedSections: 12 },
    unmatched: [],
  };
}

test("budget: bloated context is cut under the budget, still complete JSON", () => {
  const ctx = bloatedContext();
  // Stage sizes measured on this fixture: full 3559 → smallest stage 2104.
  const full = JSON.stringify(presentGoalContext(ctx, Number.MAX_SAFE_INTEGER));
  const out = presentGoalContext(ctx, 2200);
  const json = JSON.stringify(out);
  assert.ok(full.length > 2200, `fixture not bloated enough (${full.length})`);
  assert.ok(json.length <= 2200, `budget exceeded: ${json.length}`);
  // Cutting never truncates structure.
  assert.doesNotThrow(() => JSON.parse(json));
});

test("budget: similarities drop before section rows collapse", () => {
  const ctx = bloatedContext();
  // Measured on this fixture: sims-dropped-with-full-rows stage = 3025 chars,
  // the first row-collapsing stage fits at 2281 — 3100 lands in the window.
  const out = presentGoalContext(ctx, 3100);
  assert.ok(!("similarities" in out), "similarities should be cut at this budget");
  const sections = out.sections as Record<string, unknown>[];
  assert.ok("bars" in sections[0], "rows collapsed before similarities dropped");
  assert.ok(JSON.stringify(out).length <= 3100);
});

test("song scope: compact answer with top observations and the unmatched echo", () => {
  const ctx = projectGoalContext(buildDropIntel(), goalOf({ target: { section: "Chorus" } }));
  const out = presentGoalContext(ctx);
  assert.equal(out.scope, "song");
  assert.ok(!("sections" in out), "empty slices are omitted, not [] noise");
  assert.deepEqual(out.unmatched, ["section「Chorus」"]);
  assert.ok((out.observations as unknown[]).length <= 5);
});
