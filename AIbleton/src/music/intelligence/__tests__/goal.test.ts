/**
 * goal.test.ts — projectGoalContext: the goal's own words select the slice,
 * deterministically, with the song-scope fallback when nothing resolves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { MusicalObservation } from "../../reasoning/types.js";
import { deriveCreativeActions } from "../../actions/index.js";
import type { MusicIntelligence } from "../types.js";
import {
  MAX_CONTEXT_OBSERVATIONS,
  MAX_SONG_OBSERVATIONS,
  collectGoalFocus,
  projectGoalContext,
} from "../goal.js";
import { buildDropIntel, goalOf, repeatIntel } from "./fixtures.js";

test("focus: collects target and criterion terms, strips baseline:", () => {
  const focus = collectGoalFocus(
    goalOf({
      target: { section: "Drop", track: "Kick" },
      constraints: [{ kind: "tracks_untouched", names: ["Pad"] }],
      successCriteria: [
        { kind: "section_energy_gt", a: "Drop", b: "baseline:Build" },
        { kind: "section_tracks_gte", section: "Chorus", n: "baseline" },
        { kind: "role_present", role: "low_end", section: "Drop" },
        { kind: "track_crest_gte", track: "Kick", db: 6 },
        { kind: "tempo_unchanged" },
      ],
    }),
  );
  assert.deepEqual(focus.sections, ["Drop", "Build", "Chorus"]);
  assert.deepEqual(focus.tracks, ["Kick", "Pad"]);
  assert.deepEqual(focus.roles, ["low_end"]);
});

test("section target: matched section + touching contrast + scoped observations", () => {
  const intel = buildDropIntel();
  const ctx = projectGoalContext(intel, goalOf({ target: { section: "Drop" } }));

  assert.equal(ctx.scope, "focused");
  assert.deepEqual(ctx.target, { section: "Drop" });
  assert.deepEqual(ctx.sections.map((s) => s.name), ["Drop"]);
  assert.deepEqual(ctx.tracks, []);
  // The Build→Drop contrast touches the scope.
  assert.equal(ctx.contrasts.length, 1);
  assert.equal(ctx.contrasts[0].fromSectionId, "0");
  assert.equal(ctx.contrasts[0].toSectionId, "1");
  // Every observation references the scope (section 1 — no track focus).
  assert.ok(ctx.observations.length > 0);
  for (const o of ctx.observations) {
    const refs = [o.sectionId, o.relatedSectionId, o.trackId, o.relatedTrackId];
    assert.ok(refs.includes("1"), `out-of-scope observation leaked: ${o.kind}`);
  }
  // Song-level context always rides along.
  assert.equal(ctx.song.sectionCount, 2);
  assert.ok(ctx.arc.energyCurve.length === 2);
  assert.deepEqual(ctx.unmatched, []);
});

test("criteria sections: section_energy_gt pulls both named sections", () => {
  const ctx = projectGoalContext(
    buildDropIntel(),
    goalOf({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "Build" }] }),
  );
  assert.deepEqual(ctx.sections.map((s) => s.name), ["Build", "Drop"]);
  assert.equal(ctx.contrasts.length, 1);
});

test("baseline: prefix still focuses the section itself", () => {
  const ctx = projectGoalContext(
    buildDropIntel(),
    goalOf({ successCriteria: [{ kind: "section_energy_gt", a: "Drop", b: "baseline:Drop" }] }),
  );
  assert.deepEqual(ctx.sections.map((s) => s.name), ["Drop"]);
  assert.deepEqual(ctx.unmatched, []);
});

test("role criterion: low_end expands to kick|bass tracks (same table as evaluation)", () => {
  const ctx = projectGoalContext(
    buildDropIntel(),
    goalOf({ successCriteria: [{ kind: "role_present", role: "low_end", section: "Drop" }] }),
  );
  assert.deepEqual(ctx.tracks.map((t) => t.name), ["Kick", "Bass"]);
  assert.deepEqual(ctx.sections.map((s) => s.name), ["Drop"]);
  assert.deepEqual(ctx.unmatched, []);
});

test("role with no matching track echoes as unmatched", () => {
  const ctx = projectGoalContext(
    buildDropIntel(),
    goalOf({ successCriteria: [{ kind: "role_present", role: "vocal" }] }),
  );
  assert.deepEqual(ctx.tracks, []);
  assert.deepEqual(ctx.unmatched, ["role「vocal」"]);
});

test("track target: matched track + track-scoped observations only", () => {
  const ctx = projectGoalContext(buildDropIntel(), goalOf({ target: { track: "Kick" } }));
  assert.deepEqual(ctx.tracks.map((t) => t.name), ["Kick"]);
  assert.deepEqual(ctx.sections, []);
  for (const o of ctx.observations) {
    const refs = [o.sectionId, o.relatedSectionId, o.trackId, o.relatedTrackId];
    assert.ok(refs.includes("0"), `out-of-scope observation leaked: ${o.kind}`);
  }
});

test("substring match follows the goal layer's findSection semantics", () => {
  const intel = repeatIntel();
  const ctx = projectGoalContext(intel, goalOf({ target: { section: "drop 2" } }));
  assert.deepEqual(ctx.target, { section: "drop 2" });
  assert.ok(ctx.sections.some((s) => s.name === "Drop 2"));
});

test("repeat partner pull-in: a Drop 2 goal also sees Drop 1 and the pair", () => {
  const intel = repeatIntel();
  const ctx = projectGoalContext(intel, goalOf({ target: { section: "Drop 2" } }));
  const names = ctx.sections.map((s) => s.name);
  assert.ok(names.includes("Drop 2"));
  assert.ok(names.includes("Drop 1"), `repetition partner not pulled in: ${names}`);
  // The pair's similarity is inside the scope now.
  const pair = ctx.similarities.find(
    (s) =>
      (intel.features.sections[Number(s.aSectionId)].name === "Drop 1" &&
        intel.features.sections[Number(s.bSectionId)].name === "Drop 2") ||
      (intel.features.sections[Number(s.aSectionId)].name === "Drop 2" &&
        intel.features.sections[Number(s.bSectionId)].name === "Drop 1"),
  );
  assert.ok(pair, "Drop 1↔Drop 2 similarity missing");
  assert.notEqual(pair.kind, "different");
});

test("fallback: unmatched focus degrades to song scope with the echo", () => {
  const intel = buildDropIntel();
  const ctx = projectGoalContext(intel, goalOf({ target: { section: "Chorus" } }));
  assert.equal(ctx.scope, "song");
  assert.deepEqual(ctx.sections, []);
  assert.deepEqual(ctx.tracks, []);
  assert.deepEqual(ctx.contrasts, []);
  assert.deepEqual(ctx.similarities, []);
  assert.deepEqual(ctx.unmatched, ["section「Chorus」"]);
  assert.ok(ctx.observations.length <= MAX_SONG_OBSERVATIONS);
  // Song scope still answers with the global picture.
  assert.equal(ctx.song.sectionCount, 2);
});

test("fallback: a global goal (no focus terms) gets song scope, nothing unmatched", () => {
  const ctx = projectGoalContext(
    buildDropIntel(),
    goalOf({ successCriteria: [{ kind: "track_count_gte", n: "baseline" }] }),
  );
  assert.equal(ctx.scope, "song");
  assert.deepEqual(ctx.unmatched, []);
  assert.ok(ctx.observations.length <= MAX_SONG_OBSERVATIONS);
});

// ---------------------------------------------------------------------------
// Ranking / cap — synthetic observations over a minimal container: the
// projection only filters and ranks, so literal data tests exactly that.
// ---------------------------------------------------------------------------

function syntheticIntel(obs: MusicalObservation[]): MusicIntelligence {
  return {
    features: {
      song: {
        durationBeats: 64,
        bars: 16,
        trackCount: 1,
        midiTrackCount: 1,
        audioTrackCount: 0,
        tempo: 120,
        sectionCount: 1,
      },
      sections: [
        {
          sectionId: "0",
          name: "Drop",
          startBeat: 0,
          endBeat: 64,
          bars: 16,
          density: 8,
          activeTrackRatio: 1,
        },
      ],
      tracks: [{ trackId: "0", name: "Kick", muted: false, activeRatio: 1 }],
    },
    relationships: {
      contrasts: [],
      similarities: [],
      arc: { energyCurve: [undefined], energyCoverage: 0 },
    },
    reasoning: { observations: obs, coverage: { sections: 1, analyzedSections: 0 } },
    // The real chain: synthetic observations derive their own actions, so
    // the projection's action filter is exercised, not stubbed.
    actions: deriveCreativeActions({ observations: obs, coverage: { sections: 1, analyzedSections: 0 } }),
  };
}

function obs(kind: string, strength: number, confidence?: number): MusicalObservation {
  return {
    kind: kind as MusicalObservation["kind"],
    sectionId: "0",
    strength,
    ...(confidence !== undefined ? { confidence } : {}),
    evidence: [],
  };
}

test("ranking: strength × (confidence ?? 1) desc, ties keep emission order, capped", () => {
  const obs12 = [
    obs("energy_increase", 0.5, 0.2), // 0.10
    obs("energy_decrease", 0.9, 0.5), // 0.45
    obs("density_increase", 0.7), // 0.70 (no confidence → ×1)
    obs("layer_increase", 0.7), // 0.70 tie — emission order wins
    obs("clear_build", 0.2),
    obs("breakdown_after_peak", 0.15),
    obs("energy_recovery", 0.12),
    obs("section_reprise", 0.11),
    obs("repeated_section_low_variation", 0.1), // 0.10 tie with #0, later
    obs("repeated_section_with_evolution", 0.09),
    obs("strong_rhythmic_foundation", 0.08),
    obs("low_frequency_co_activity", 0.07),
  ];
  const ctx = projectGoalContext(
    syntheticIntel(obs12),
    goalOf({ target: { section: "Drop" } }),
  );
  assert.equal(ctx.observations.length, MAX_CONTEXT_OBSERVATIONS);
  assert.deepEqual(
    ctx.observations.map((o) => o.kind),
    [
      "density_increase", // 0.70, emitted before the other 0.70
      "layer_increase", // 0.70
      "energy_decrease", // 0.45
      "clear_build", // 0.20
      "breakdown_after_peak", // 0.15
      "energy_recovery", // 0.12
      "section_reprise", // 0.11
      "energy_increase", // 0.10 — beats repeated_section_low_variation (0.10) on emission order
    ],
  );
});

// ---------------------------------------------------------------------------
// Scope growth regressions (real-machine lessons): chain-proof pull-in and
// best-partner-only, over synthetic similarities.
// ---------------------------------------------------------------------------

function growthIntel(
  sims: { a: string; b: string; sim: number; kind: "repeat" | "similar" | "different" }[],
): MusicIntelligence {
  const names = ["A", "B", "C"];
  return {
    features: {
      song: {
        durationBeats: 192,
        bars: 48,
        trackCount: 1,
        midiTrackCount: 1,
        audioTrackCount: 0,
        tempo: 120,
        sectionCount: 3,
      },
      sections: names.map((name, i) => ({
        sectionId: String(i),
        name,
        startBeat: i * 64,
        endBeat: (i + 1) * 64,
        bars: 16,
        density: 8,
        activeTrackRatio: 1,
      })),
      tracks: [{ trackId: "0", name: "Kick", muted: false, activeRatio: 1 }],
    },
    relationships: {
      contrasts: [],
      similarities: sims.map((s) => ({
        aSectionId: s.a,
        bSectionId: s.b,
        similarity: { value: s.sim, source: "derived" as const },
        kind: s.kind,
      })),
      arc: { energyCurve: [0.9, 0.9, 0.9], energyCoverage: 1 },
    },
    reasoning: { observations: [], coverage: { sections: 3, analyzedSections: 3 } },
    actions: { actions: [], coverage: { sourceObservations: 0, actionableObservations: 0 } },
  };
}

test("growth is chain-proof: a partner's own partner is NOT pulled", () => {
  // A↔B repeat, B↔C repeat, A↔C different — pulling must stop at B.
  const ctx = projectGoalContext(
    growthIntel([
      { a: "0", b: "1", sim: 1, kind: "repeat" },
      { a: "0", b: "2", sim: 0.3, kind: "different" },
      { a: "1", b: "2", sim: 1, kind: "repeat" },
    ]),
    goalOf({ target: { section: "A" } }),
  );
  assert.deepEqual(ctx.sections.map((s) => s.name), ["A", "B"]);
});

test("growth keeps only the anchor's STRONGEST repeat partner", () => {
  const ctx = projectGoalContext(
    growthIntel([
      { a: "0", b: "1", sim: 0.92, kind: "repeat" },
      { a: "0", b: "2", sim: 0.97, kind: "repeat" },
      { a: "1", b: "2", sim: 0.5, kind: "different" },
    ]),
    goalOf({ target: { section: "A" } }),
  );
  assert.deepEqual(ctx.sections.map((s) => s.name), ["A", "C"]);
});

test("growth ignores similar pairs even when strong", () => {
  const ctx = projectGoalContext(
    growthIntel([
      { a: "0", b: "1", sim: 0.89, kind: "similar" },
      { a: "0", b: "2", sim: 0.85, kind: "similar" },
      { a: "1", b: "2", sim: 0.8, kind: "similar" },
    ]),
    goalOf({ target: { section: "A" } }),
  );
  assert.deepEqual(ctx.sections.map((s) => s.name), ["A"]);
});

test("determinism: same inputs → deep-equal projections, twice", () => {
  const intel = buildDropIntel();
  const goal = goalOf({ target: { section: "Drop" } });
  assert.deepEqual(projectGoalContext(intel, goal), projectGoalContext(intel, goal));
});

// ---------------------------------------------------------------------------
// Creative actions (PR14): the projection selects from the action layer's
// own ranked set — song-scope actions ride every scope, id-targeted ones
// follow the focus.
// ---------------------------------------------------------------------------

test("actions: a Drop 2 goal sees introduce_variation for the repeat pair", () => {
  const intel = repeatIntel();
  // Precondition: the chained reasoning flags the Drop 1↔Drop 2 repeat.
  const pair = intel.reasoning.observations.find(
    (o) => o.kind === "repeated_section_low_variation",
  );
  assert.ok(pair, "fixture no longer produces the repeat observation");

  const ctx = projectGoalContext(intel, goalOf({ target: { section: "Drop 2" } }));
  const action = ctx.actions.find((a) => a.kind === "introduce_variation");
  assert.ok(action, "introduce_variation not projected into the goal context");
  assert.equal(action.target.sectionId, pair.sectionId);
  assert.equal(action.target.relatedSectionId, pair.relatedSectionId);
  // The why-chain survives projection untouched.
  assert.equal(action.sourceObservations[0], pair);
});

test("actions: an out-of-scope target filters the pair action away", () => {
  const ctx = projectGoalContext(repeatIntel(), goalOf({ target: { section: "Verse" } }));
  assert.deepEqual(
    ctx.actions.filter((a) => a.kind === "introduce_variation"),
    [],
  );
});

test("actions: song-scope fallback still carries candidates (capped)", () => {
  const ctx = projectGoalContext(repeatIntel(), goalOf({ target: { section: "Chorus" } }));
  assert.equal(ctx.scope, "song");
  assert.ok(ctx.actions.length <= MAX_SONG_OBSERVATIONS);
  assert.ok(ctx.actions.some((a) => a.kind === "introduce_variation"));
});
