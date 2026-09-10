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

function sectionMissing(name: string, view: GoalView): GoalCheck["actual"] {
  return `可用段落: ${view.sections.map((s) => s.name).join(", ") || "(无)"}`;
}

function judgeSectionEnergyGt(
  a: string,
  b: string,
  before: GoalView,
  after: GoalView,
): GoalCheck {
  const id = `section[${a}].energy`;
  const sa = findSection(after, a);
  if (!sa) return { id, passed: false, expected: `段落「${a}」存在`, actual: sectionMissing(a, after) };

  const baselineMatch = b.match(/^baseline:(.+)$/i);
  let sb: GoalSectionMeasure | undefined;
  let bLabel: string;
  if (baselineMatch) {
    const bName = baselineMatch[1].trim();
    sb = findSection(before, bName);
    bLabel = `基线「${bName}」`;
    if (!sb) {
      return { id, passed: false, expected: `基线中存在段落「${bName}」`, actual: sectionMissing(bName, before) };
    }
  } else {
    sb = findSection(after, b);
    bLabel = `「${b}」`;
    if (!sb) return { id, passed: false, expected: `段落「${b}」存在`, actual: sectionMissing(b, after) };
  }

  return {
    id,
    passed: sa.density > sb.density + EPS,
    expected: `「${sa.name}」能量密度 > ${bLabel}（${fmt(sb.density)}/bar）`,
    actual: `${fmt(sa.density)}/bar`,
  };
}

function judgeSectionTracksGte(
  section: string,
  n: number | "baseline",
  before: GoalView,
  after: GoalView,
): GoalCheck {
  const id = `section[${section}].tracks`;
  const s = findSection(after, section);
  if (!s) return { id, passed: false, expected: `段落「${section}」存在`, actual: sectionMissing(section, after) };
  const want = n === "baseline" ? (findSection(before, section)?.tracks ?? 0) : n;
  const wantLabel = n === "baseline" ? `基线 ${want}` : `${want}`;
  return {
    id,
    passed: s.tracks >= want,
    expected: `「${s.name}」参与轨数 ≥ ${wantLabel}`,
    actual: `${s.tracks}`,
  };
}

function judgeRolePresent(
  role: string,
  section: string | undefined,
  after: GoalView,
): GoalCheck {
  const want = ROLE_GROUPS[role] ?? [role];
  const id = section ? `role[${role}]@${section}` : `role[${role}]`;
  const sec = section ? findSection(after, section) : undefined;
  if (section && !sec) {
    return { id, passed: false, expected: `段落「${section}」存在`, actual: sectionMissing(section, after) };
  }
  const scope: ReadonlySet<string> = sec ? sec.roles : after.songRoles;
  const scopeLabel = section ? `「${section}」` : "全曲";
  const hit = want.some((r) => scope.has(r));
  return {
    id,
    passed: hit,
    expected: `${scopeLabel}存在 ${role}${ROLE_GROUPS[role] ? `（${want.join("|")}）` : ""}`,
    actual: `现有角色: ${[...scope].join(", ") || "(无)"}`,
  };
}

function judgeTracksUntouched(names: string[], before: GoalView, after: GoalView): GoalCheck {
  const bad: string[] = [];
  for (const name of names) {
    const norm = name.trim().toLowerCase();
    const a = after.tracks.find((t) => t.name.toLowerCase() === norm);
    const b = before.tracks.find((t) => t.name.toLowerCase() === norm);
    if (!a) {
      bad.push(`「${name}」已不存在`);
      continue;
    }
    // Notes-based proxy: a track whose audible content changed counts as
    // touched. Mixer/device tweaks are invisible here (documented in the
    // tool schema) — content identity is what this constraint protects.
    if (b && a.notes !== b.notes) bad.push(`「${name}」音符 ${b.notes} → ${a.notes}`);
  }
  return {
    id: `untouched[${names.join(",")}]`,
    passed: bad.length === 0,
    expected: `轨道 ${names.map((n) => `「${n}」`).join("")} 内容不变`,
    actual: bad.join("；") || "未改动",
  };
}

/** Track lookup shared by the audio judges: exact (case-insensitive) name,
 * mirroring judgeTracksUntouched. A missing track fails with what exists. */
function findTrack(view: GoalView, name: string): GoalView["tracks"][number] | undefined {
  const norm = name.trim().toLowerCase();
  return view.tracks.find((t) => t.name.toLowerCase() === norm);
}

const trackMissing = (name: string, view: GoalView): string =>
  `可用轨道: ${view.tracks.map((t) => t.name).join(", ") || "(无)"}`;

const NO_AUDIO = "无音频特征（目标声明/校验时未启用音频分析）";

/** in_key / off_key_lte share one judge — in_key is off_key_lte at the
 * OFF_KEY issue threshold, so a set that doesn't trigger the issue passes
 * in_key by construction. An unmeasurable ratio FAILS (unknown ≠ clean),
 * with the reason spelled out so the model can act on it. */
function judgeOffKeyLte(pct: number, after: GoalView): GoalCheck {
  const id = "offKey";
  if (after.offKeyRatio === undefined) {
    return {
      id,
      passed: false,
      expected: `调外音占比可测量（Live Scale Mode 已开启，或可检测调性 + 足够音符材料）`,
      actual: "无法测量 — 无可用调式或音符材料不足",
    };
  }
  return {
    id,
    passed: after.offKeyRatio <= pct + EPS,
    expected: `调外音时长占比 ≤ ${fmt(pct * 100)}%（按 ${after.offKeyScale}）`,
    actual: `${fmt(after.offKeyRatio * 100)}%`,
  };
}

function judgeTrackCrestGte(track: string, db: number, after: GoalView): GoalCheck {
  const id = `track[${track}].crest`;
  const t = findTrack(after, track);
  if (!t) return { id, passed: false, expected: `轨道「${track}」存在`, actual: trackMissing(track, after) };
  if (!t.audio) return { id, passed: false, expected: `「${t.name}」有音频特征`, actual: NO_AUDIO };
  return {
    id,
    passed: t.audio.crestDb >= db,
    expected: `「${t.name}」源文件 crest ≥ ${fmt(db)} dB`,
    actual: `${fmt(t.audio.crestDb)} dB`,
  };
}

function judgeTrackBandGte(track: string, band: string, pct: number, after: GoalView): GoalCheck {
  const id = `track[${track}].band[${band}]`;
  const t = findTrack(after, track);
  if (!t) return { id, passed: false, expected: `轨道「${track}」存在`, actual: trackMissing(track, after) };
  if (!t.audio) return { id, passed: false, expected: `「${t.name}」有音频特征`, actual: NO_AUDIO };
  const v = t.audio.bands[band as keyof typeof t.audio.bands];
  return {
    id,
    passed: v >= pct,
    expected: `「${t.name}」源文件 ${band} 频段能量占比 ≥ ${fmt(pct)}`,
    actual: `${fmt(v)}`,
  };
}

// ---------------------------------------------------------------------------
// gen_* judges — the generation registry (genlog/) as the measurement surface.
// Both fail closed: no record, no features, or no NEW generation this turn is
// a failed check with the reason spelled out, never a silent pass.
// ---------------------------------------------------------------------------

const NO_GENLOG = "genlog 为空 — 本回合尚未生成音频（generate_audio 成功后才会记录）";

function genValue(
  g: GoalGenMeasure,
  metric: GenCriterionMetric,
  band?: AudioBandName,
): number | undefined {
  return g.features ? genMetricValue(g.features, metric, band) : undefined;
}

function metricLabel(metric: GenCriterionMetric, band?: AudioBandName): string {
  return metric === "band" ? `${band} 频段能量占比` : metric;
}

function judgeGenMetricGte(
  metric: GenCriterionMetric,
  band: AudioBandName | undefined,
  value: number,
  after: GoalView,
): GoalCheck {
  const id = metric === "band" ? `gen.band[${band}]` : `gen.${metric}`;
  const gen = after.latestGeneration;
  if (!gen) return { id, passed: false, expected: `存在生成记录`, actual: NO_GENLOG };
  const v = genValue(gen, metric, band);
  if (v === undefined) {
    return {
      id,
      passed: false,
      expected: `最新生成（${gen.id}）可分析`,
      actual: gen.featuresError ? `无法分析: ${gen.featuresError}` : "无音频特征",
    };
  }
  return {
    id,
    passed: v >= value,
    expected: `最新生成（${gen.id}）${metricLabel(metric, band)} ≥ ${fmt(value)}`,
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
): GoalCheck {
  const id = metric === "band" ? `gen.band[${band}].improved` : `gen.${metric}.improved`;
  const cur = after.latestGeneration;
  if (!cur) return { id, passed: false, expected: `存在生成记录`, actual: NO_GENLOG };
  const prev = before.latestGeneration;
  if (!prev) {
    return {
      id,
      passed: false,
      expected: `set_goal 时已有上一轮生成记录作基线`,
      actual: "声明目标时 genlog 为空 — 无可比较的上一迭代",
    };
  }
  if (cur.id === prev.id) {
    return {
      id,
      passed: false,
      expected: `本回合产生新的生成（区别于基线 ${prev.id}）`,
      actual: "没有新生成 — 最新记录仍是基线那一条",
    };
  }
  const curV = genValue(cur, metric, band);
  if (curV === undefined) {
    return {
      id,
      passed: false,
      expected: `新生成（${cur.id}）可分析`,
      actual: cur.featuresError ? `无法分析: ${cur.featuresError}` : "无音频特征",
    };
  }
  const prevV = genValue(prev, metric, band);
  if (prevV === undefined) {
    return {
      id,
      passed: false,
      expected: `基线生成（${prev.id}）可分析`,
      actual: prev.featuresError ? `无法分析: ${prev.featuresError}` : "无音频特征",
    };
  }
  const delta = curV - prevV;
  const improved = direction === "up" ? delta >= minDelta : -delta >= minDelta;
  const dirLabel = direction === "up" ? "提升" : "降低";
  return {
    id,
    passed: improved,
    expected: `${metricLabel(metric, band)}较上一轮（${prev.id}）${dirLabel} ≥ ${fmt(minDelta)}`,
    actual: `${fmt(prevV)} → ${fmt(curV)}（Δ ${fmt(delta)}）`,
  };
}

function judge(c: Criterion, before: GoalView, after: GoalView): GoalCheck {
  switch (c.kind) {
    case "section_energy_gt":
      return judgeSectionEnergyGt(c.a, c.b, before, after);
    case "section_tracks_gte":
      return judgeSectionTracksGte(c.section, c.n, before, after);
    case "role_present":
      return judgeRolePresent(c.role, c.section, after);
    case "tempo_unchanged":
      return {
        id: "tempo",
        passed: Math.abs(after.tempo - before.tempo) <= 0.01,
        expected: `速度保持 ${fmt(before.tempo)} BPM`,
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
          expected: `调式保持 ${pcName(before.liveScale.root)} ${before.liveScale.name}`,
          actual: `${pcName(after.liveScale.root)} ${after.liveScale.name}`,
        };
      }
      return {
        id: "key",
        passed: after.keyBest === before.keyBest,
        expected: `调性保持 ${before.keyBest ?? "(无法检测)"}`,
        actual: after.keyBest ?? "(无法检测)",
      };
    }
    case "in_key":
      return judgeOffKeyLte(OFF_KEY_THRESHOLD, after);
    case "off_key_lte":
      return judgeOffKeyLte(c.pct, after);
    case "track_count_gte": {
      const want = c.n === "baseline" ? before.trackCount : c.n;
      return {
        id: "trackCount",
        passed: after.trackCount >= want,
        expected: `轨道总数 ≥ ${c.n === "baseline" ? `基线 ${want}` : want}`,
        actual: `${after.trackCount}`,
      };
    }
    case "no_new_tracks":
      return {
        id: "noNewTracks",
        passed: after.trackCount <= before.trackCount,
        expected: `不新增轨道（基线 ${before.trackCount}）`,
        actual: `${before.trackCount} → ${after.trackCount}`,
      };
    case "tracks_untouched":
      return judgeTracksUntouched(c.names, before, after);
    case "track_crest_gte":
      return judgeTrackCrestGte(c.track, c.db, after);
    case "track_band_gte":
      return judgeTrackBandGte(c.track, c.band, c.pct, after);
    case "gen_metric_gte":
      return judgeGenMetricGte(c.metric, c.band, c.value, after);
    case "gen_improved_vs_prev":
      return judgeGenImprovedVsPrev(c.metric, c.band, c.direction, c.min_delta, before, after);
  }
}

const issueLine = (c: GoalCheck): string =>
  `${c.id}: 期望 ${c.expected}${c.actual ? `，实际 ${c.actual}` : ""}`;

export function evaluateGoal(
  goal: MusicGoal,
  before: GoalView,
  after: GoalView,
): GoalEvaluation {
  const checks = [
    ...goal.constraints.map((c) => ({ ...judge(c, before, after), constraint: true })),
    ...goal.successCriteria.map((c) => ({ ...judge(c, before, after), constraint: false })),
  ];
  const constraintIssues = checks.filter((c) => c.constraint && !c.passed).map(issueLine);
  const criteriaIssues = checks.filter((c) => !c.constraint && !c.passed).map(issueLine);
  return {
    met: constraintIssues.length === 0 && criteriaIssues.length === 0,
    checks,
    constraintIssues,
    criteriaIssues,
  };
}
