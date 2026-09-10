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

import type { Criterion, GoalCheck, GoalEvaluation, MusicGoal } from "./types.js";
import { findSection, type GoalSectionMeasure, type GoalView } from "./view.js";

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
    case "key_unchanged":
      return {
        id: "key",
        passed: after.keyBest === before.keyBest,
        expected: `调性保持 ${before.keyBest ?? "(无法检测)"}`,
        actual: after.keyBest ?? "(无法检测)",
      };
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
