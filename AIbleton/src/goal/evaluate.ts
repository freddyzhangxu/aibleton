/**
 * goal/evaluate.ts — judges a declared MusicGoal against before/after views.
 *
 * Every criterion kind has exactly one judge here; judges are pure functions
 * over two GoalViews (no Live, no SDK), so fixtures can exercise them offline.
 * A missing reference (section renamed away, track deleted) is a FAILED check
 * with the available names as `actual` — "could not find the thing you said
 * you'd change" is a finding, not an exception.
 *
 * Constraints and successCriteria use the same judges; the difference is only
 * in reporting (violated boundary vs unmet outcome) and in how server.ts
 * phrases the retry injection.
 */

import { OFF_KEY_THRESHOLD, pcName } from "../analysis/interpret.js";
import { genMetricValue } from "../genlog/diff.js";
import { goalIssue, goalMetricLabel, goalText } from "./i18n.js";
import type { Criterion, GenCriterionMetric, GoalCheck, GoalEvaluation, MusicGoal } from "./types.js";
import {
  findSection,
  type GoalGenMeasure,
  type GoalSectionMeasure,
  type GoalView,
} from "./view.js";
import type { AudioBandName } from "../dsp.js";

const fmt = (v: number): string => String(Math.round(v * 100) / 100);
const EPS = 1e-6;

/** kick|bass — the "low-end present" shorthand. Exported for the music
 * intelligence layer, which resolves goal roles against the same groups. */
export const ROLE_GROUPS: Record<string, string[]> = {
  low_end: ["kick", "bass"],
};

function sectionMissing(view: GoalView, language?: string): GoalCheck["actual"] {
  return goalText(language, "availableSections", view.sections.map((s) => s.name).join(", ") || goalText(language, "none"));
}

function judgeSectionEnergyGt(
  a: string,
  b: string,
  before: GoalView,
  after: GoalView,
  language?: string,
): GoalCheck {
  const id = `section[${a}].energy`;
  const sa = findSection(after, a);
  if (!sa) return { id, passed: false, expected: goalText(language, "sectionExists", a), actual: sectionMissing(after, language) };

  const baselineMatch = b.match(/^baseline:(.+)$/i);
  let sb: GoalSectionMeasure | undefined;
  let bLabel: string;
  if (baselineMatch) {
    const bName = baselineMatch[1].trim();
    sb = findSection(before, bName);
    bLabel = goalText(language, "baseline", bName);
    if (!sb) {
      return { id, passed: false, expected: goalText(language, "baselineSectionExists", bName), actual: sectionMissing(before, language) };
    }
  } else {
    sb = findSection(after, b);
    bLabel = b;
    if (!sb) return { id, passed: false, expected: goalText(language, "sectionExists", b), actual: sectionMissing(after, language) };
  }

  return {
    id,
    passed: sa.density > sb.density + EPS,
    expected: goalText(language, "sectionEnergy", sa.name, bLabel, fmt(sb.density)),
    actual: `${fmt(sa.density)}/bar`,
  };
}

function judgeSectionTracksGte(
  section: string,
  n: number | "baseline",
  before: GoalView,
  after: GoalView,
  language?: string,
): GoalCheck {
  const id = `section[${section}].tracks`;
  const s = findSection(after, section);
  if (!s) return { id, passed: false, expected: goalText(language, "sectionExists", section), actual: sectionMissing(after, language) };
  const want = n === "baseline" ? (findSection(before, section)?.tracks ?? 0) : n;
  const wantLabel = n === "baseline" ? goalText(language, "baseline", want) : `${want}`;
  return {
    id,
    passed: s.tracks >= want,
    expected: goalText(language, "sectionTracks", s.name, wantLabel),
    actual: `${s.tracks}`,
  };
}

function judgeRolePresent(
  role: string,
  section: string | undefined,
  after: GoalView,
  language?: string,
): GoalCheck {
  const want = ROLE_GROUPS[role] ?? [role];
  const id = section ? `role[${role}]@${section}` : `role[${role}]`;
  const sec = section ? findSection(after, section) : undefined;
  if (section && !sec) {
    return { id, passed: false, expected: goalText(language, "sectionExists", section), actual: sectionMissing(after, language) };
  }
  const scope: ReadonlySet<string> = sec ? sec.roles : after.songRoles;
  const scopeLabel = section ?? goalText(language, "wholeSong");
  const hit = want.some((r) => scope.has(r));
  return {
    id,
    passed: hit,
    expected: goalText(language, "rolePresent", scopeLabel, role, ROLE_GROUPS[role] ? ` (${want.join("|")})` : ""),
    actual: goalText(language, "currentRoles", [...scope].join(", ") || goalText(language, "none")),
  };
}

function judgeTracksUntouched(names: string[], before: GoalView, after: GoalView, language?: string): GoalCheck {
  const bad: string[] = [];
  for (const name of names) {
    const norm = name.trim().toLowerCase();
    const a = after.tracks.find((t) => t.name.toLowerCase() === norm);
    const b = before.tracks.find((t) => t.name.toLowerCase() === norm);
    if (!a) {
      bad.push(goalText(language, "trackGone", name));
      continue;
    }
    // Notes-based proxy: a track whose audible content changed counts as
    // touched. Mixer/device tweaks are invisible here (documented in the
    // tool schema) — content identity is what this constraint protects.
    if (b && a.notes !== b.notes) bad.push(goalText(language, "notesChanged", name, b.notes, a.notes));
  }
  return {
    id: `untouched[${names.join(",")}]`,
    passed: bad.length === 0,
    expected: goalText(language, "tracksUnchanged", names.join(", ")),
    actual: bad.join("; ") || goalText(language, "notChanged"),
  };
}

/** Track lookup shared by the audio judges: exact (case-insensitive) name,
 * mirroring judgeTracksUntouched. A missing track fails with what exists. */
function findTrack(view: GoalView, name: string): GoalView["tracks"][number] | undefined {
  const norm = name.trim().toLowerCase();
  return view.tracks.find((t) => t.name.toLowerCase() === norm);
}

const trackMissing = (view: GoalView, language?: string): string =>
  goalText(language, "availableTracks", view.tracks.map((t) => t.name).join(", ") || goalText(language, "none"));

/** in_key / off_key_lte share one judge — in_key is off_key_lte at the
 * OFF_KEY issue threshold, so a set that doesn't trigger the issue passes
 * in_key by construction. An unmeasurable ratio FAILS (unknown ≠ clean),
 * with the reason spelled out so the model can act on it. */
function judgeOffKeyLte(pct: number, after: GoalView, language?: string): GoalCheck {
  const id = "offKey";
  if (after.offKeyRatio === undefined) {
    return {
      id,
      passed: false,
      expected: goalText(language, "offKeyMeasurable"),
      actual: goalText(language, "offKeyUnavailable"),
    };
  }
  return {
    id,
    passed: after.offKeyRatio <= pct + EPS,
    expected: goalText(language, "offKeyShare", fmt(pct * 100), after.offKeyScale),
    actual: `${fmt(after.offKeyRatio * 100)}%`,
  };
}

function judgeTrackCrestGte(track: string, db: number, after: GoalView, language?: string): GoalCheck {
  const id = `track[${track}].crest`;
  const t = findTrack(after, track);
  if (!t) return { id, passed: false, expected: goalText(language, "trackExists", track), actual: trackMissing(after, language) };
  if (!t.audio) return { id, passed: false, expected: goalText(language, "trackAudioFeatures", t.name), actual: goalText(language, "noAudio") };
  return {
    id,
    passed: t.audio.crestDb >= db,
    expected: goalText(language, "sourceCrest", t.name, fmt(db)),
    actual: `${fmt(t.audio.crestDb)} dB`,
  };
}

function judgeTrackBandGte(track: string, band: string, pct: number, after: GoalView, language?: string): GoalCheck {
  const id = `track[${track}].band[${band}]`;
  const t = findTrack(after, track);
  if (!t) return { id, passed: false, expected: goalText(language, "trackExists", track), actual: trackMissing(after, language) };
  if (!t.audio) return { id, passed: false, expected: goalText(language, "trackAudioFeatures", t.name), actual: goalText(language, "noAudio") };
  const v = t.audio.bands[band as keyof typeof t.audio.bands];
  return {
    id,
    passed: v >= pct,
    expected: goalText(language, "sourceBand", t.name, band, fmt(pct)),
    actual: `${fmt(v)}`,
  };
}

// ---------------------------------------------------------------------------
// gen_* judges — the generation registry (genlog/) as the measurement surface.
// Both fail closed: no record, no features, or no NEW generation this turn is
// a failed check with the reason spelled out, never a silent pass.
// ---------------------------------------------------------------------------

function genValue(
  g: GoalGenMeasure,
  metric: GenCriterionMetric,
  band?: AudioBandName,
): number | undefined {
  return g.features ? genMetricValue(g.features, metric, band) : undefined;
}

function judgeGenMetricGte(
  metric: GenCriterionMetric,
  band: AudioBandName | undefined,
  value: number,
  after: GoalView,
  language?: string,
): GoalCheck {
  const id = metric === "band" ? `gen.band[${band}]` : `gen.${metric}`;
  const gen = after.latestGeneration;
  if (!gen) return { id, passed: false, expected: goalText(language, "generationExists"), actual: goalText(language, "noGenlog") };
  const v = genValue(gen, metric, band);
  if (v === undefined) {
    return {
      id,
      passed: false,
      expected: goalText(language, "generationAnalyzable", gen.id),
      actual: gen.featuresError ? goalText(language, "analysisFailed", gen.featuresError) : goalText(language, "noAudioFeatures"),
    };
  }
  return {
    id,
    passed: v >= value,
    expected: goalText(language, "latestGenerationMetric", gen.id, goalMetricLabel(language, metric, band), fmt(value)),
    actual: fmt(v),
  };
}

function judgeGenImprovedVsPrev(
  metric: GenCriterionMetric,
  band: AudioBandName | undefined,
  direction: "up" | "down",
  minDelta: number,
  before: GoalView,
  after: GoalView,
  language?: string,
): GoalCheck {
  const id = metric === "band" ? `gen.band[${band}].improved` : `gen.${metric}.improved`;
  const cur = after.latestGeneration;
  if (!cur) return { id, passed: false, expected: goalText(language, "generationExists"), actual: goalText(language, "noGenlog") };
  const prev = before.latestGeneration;
  if (!prev) {
    return {
      id,
      passed: false,
      expected: goalText(language, "baselineGenerationRequired"),
      actual: goalText(language, "noBaselineGeneration"),
    };
  }
  if (cur.id === prev.id) {
    return {
      id,
      passed: false,
      expected: goalText(language, "newGenerationRequired", prev.id),
      actual: goalText(language, "noNewGeneration"),
    };
  }
  const curV = genValue(cur, metric, band);
  if (curV === undefined) {
    return {
      id,
      passed: false,
      expected: goalText(language, "generationAnalyzable", cur.id),
      actual: cur.featuresError ? goalText(language, "analysisFailed", cur.featuresError) : goalText(language, "noAudioFeatures"),
    };
  }
  const prevV = genValue(prev, metric, band);
  if (prevV === undefined) {
    return {
      id,
      passed: false,
      expected: goalText(language, "baselineGenerationAnalyzable", prev.id),
      actual: prev.featuresError ? goalText(language, "analysisFailed", prev.featuresError) : goalText(language, "noAudioFeatures"),
    };
  }
  const delta = curV - prevV;
  const improved = direction === "up" ? delta >= minDelta : -delta >= minDelta;
  const dirLabel = goalText(language, direction === "up" ? "increase" : "decrease");
  return {
    id,
    passed: improved,
    expected: goalText(language, "metricImproved", goalMetricLabel(language, metric, band), prev.id, dirLabel, fmt(minDelta)),
    actual: `${fmt(prevV)} → ${fmt(curV)}（Δ ${fmt(delta)}）`,
  };
}

function judge(c: Criterion, before: GoalView, after: GoalView, language?: string): GoalCheck {
  switch (c.kind) {
    case "section_energy_gt":
      return judgeSectionEnergyGt(c.a, c.b, before, after, language);
    case "section_tracks_gte":
      return judgeSectionTracksGte(c.section, c.n, before, after, language);
    case "role_present":
      return judgeRolePresent(c.role, c.section, after, language);
    case "tempo_unchanged":
      return {
        id: "tempo",
        passed: Math.abs(after.tempo - before.tempo) <= 0.01,
        expected: goalText(language, "tempoUnchanged", fmt(before.tempo)),
        actual: `${fmt(after.tempo)} BPM`,
      };
    case "key_unchanged": {
      // Scale Mode on in BOTH views: Live's declared scale is user-set ground
      // truth — the detected keyBest wobbles on sparse material, this doesn't.
      // Compare root + interval structure; the NAME is a localized display
      // string and is never compared. Mixed on/off falls back to keyBest:
      // toggling Scale Mode doesn't change the music's key.
      if (before.liveScale.mode && after.liveScale.mode) {
        const sameRoot =
          (((after.liveScale.root - before.liveScale.root) % 12) + 12) % 12 === 0;
        const sameIntervals =
          after.liveScale.intervals.join(",") === before.liveScale.intervals.join(",");
        return {
          id: "key",
          passed: sameRoot && sameIntervals,
          expected: goalText(language, "scaleUnchanged", pcName(before.liveScale.root), before.liveScale.name),
          actual: `${pcName(after.liveScale.root)} ${after.liveScale.name}`,
        };
      }
      return {
        id: "key",
        passed: after.keyBest === before.keyBest,
        expected: goalText(language, "keyUnchanged", before.keyBest ?? goalText(language, "undetectable")),
        actual: after.keyBest ?? goalText(language, "undetectable"),
      };
    }
    case "in_key":
      return judgeOffKeyLte(OFF_KEY_THRESHOLD, after, language);
    case "off_key_lte":
      return judgeOffKeyLte(c.pct, after, language);
    case "track_count_gte": {
      const want = c.n === "baseline" ? before.trackCount : c.n;
      return {
        id: "trackCount",
        passed: after.trackCount >= want,
        expected: goalText(language, "trackCountAtLeast", c.n === "baseline" ? goalText(language, "baseline", want) : want),
        actual: `${after.trackCount}`,
      };
    }
    case "no_new_tracks":
      return {
        id: "noNewTracks",
        passed: after.trackCount <= before.trackCount,
        expected: goalText(language, "noNewTracks", before.trackCount),
        actual: `${before.trackCount} → ${after.trackCount}`,
      };
    case "tracks_untouched":
      return judgeTracksUntouched(c.names, before, after, language);
    case "track_crest_gte":
      return judgeTrackCrestGte(c.track, c.db, after, language);
    case "track_band_gte":
      return judgeTrackBandGte(c.track, c.band, c.pct, after, language);
    case "gen_metric_gte":
      return judgeGenMetricGte(c.metric, c.band, c.value, after, language);
    case "gen_improved_vs_prev":
      return judgeGenImprovedVsPrev(c.metric, c.band, c.direction, c.min_delta, before, after, language);
  }
}

export function evaluateGoal(
  goal: MusicGoal,
  before: GoalView,
  after: GoalView,
  language?: string,
): GoalEvaluation {
  const checks = [
    ...goal.constraints.map((c) => ({ ...judge(c, before, after, language), constraint: true })),
    ...goal.successCriteria.map((c) => ({ ...judge(c, before, after, language), constraint: false })),
  ];
  const issueLine = (c: GoalCheck): string => goalIssue(language, c.id, c.expected, c.actual);
  const constraintIssues = checks.filter((c) => c.constraint && !c.passed).map(issueLine);
  const criteriaIssues = checks.filter((c) => !c.constraint && !c.passed).map(issueLine);
  return {
    met: constraintIssues.length === 0 && criteriaIssues.length === 0,
    checks,
    constraintIssues,
    criteriaIssues,
  };
}
