/**
 * genlog/suggest.ts — deterministic metric-gap → generation-parameter hints.
 *
 * The refine loop's self-correction surface: which knob to turn when the
 * artifact missed the declared bar. No LLM guessing — a closed rule table
 * keyed by the failed criterion's metric and the direction of the gap.
 * Prompt keywords are English because every provider's prompt language is;
 * the surrounding explanation follows the chat's Chinese-first style.
 *
 * One hint per failed criterion, and one global rule: adjust ONE thing per
 * iteration — a refinement that changes five parameters teaches nothing.
 */

import type { AudioBandName } from "../dsp.js";
import type { GenCriterionMetric } from "../goal/types.js";

/** Prompt keywords to ADD when the metric must move up / down. */
const PROMPT_HINTS: Record<string, { up: string; down: string }> = {
  crestDb: {
    up: "punchy, hard-hitting, sharp attack, tight transients",
    down: "soft, smooth, gentle attack, rounded transients",
  },
  rmsDb: { up: "dense, full-bodied, sustained energy", down: "sparse, light, spacious" },
  peakDb: { up: "hot, upfront, in-your-face level", down: "conservative headroom, quieter peaks" },
  loudnessDb: { up: "loud, dense, high energy, wall of sound", down: "quiet, delicate, understated" },
  dynamicRangeDb: {
    up: "dynamic, expressive, evolving intensity, human feel",
    down: "steady, consistent, uniform energy",
  },
  spectralCentroidHz: {
    up: "bright, crisp, airy highs, sparkling top end",
    down: "warm, dark, smooth, rolled-off highs",
  },
  transientDensity: {
    up: "busy groove, more rhythmic activity, percussive, driving",
    down: "minimal, laid-back, sparse rhythm, sustained",
  },
};

const BAND_HINTS: Record<AudioBandName, string> = {
  sub: "deep sub bass, 808 weight, low-end rumble",
  bass: "fat round bass, warm low end",
  lowMid: "thick body, warm low-mids",
  mid: "present mids, forward in the mix",
  highMid: "crisp presence, bright attack, definition",
  high: "airy shimmer, sparkling top end",
};

/** Keywords to suggest REMOVING when the metric must move the other way. */
const AVOID_HINTS: Record<string, string> = {
  crestDb: "soft / smooth / gentle",
  spectralCentroidHz: "bright / dark 里与目标相反方向的词",
  transientDensity: "minimal / sparse（要更密时）或 busy / driving（要更疏时）",
  loudnessDb: "quiet / loud 里与目标相反方向的词",
};

export interface GenGap {
  metric: GenCriterionMetric;
  band?: AudioBandName;
  /** Which way the metric must move to pass. */
  direction: "up" | "down";
}

/**
 * One actionable hint line for one failed gen_* criterion. Pure: the same
 * gap always yields the same hint, so the retry surface is testable and the
 * model cannot be gaslit by phrasing drift.
 */
export function suggestForGenGap(gap: GenGap): string {
  if (gap.metric === "band") {
    const hint = BAND_HINTS[gap.band ?? "mid"];
    const line =
      gap.direction === "up"
        ? `${gap.band} 频段不足 → prompt 加入「${hint}」，并考虑移除与该频段冲突的描述`
        : `${gap.band} 频段过重 → prompt 减少低频/该频段描述，或加入「light ${gap.band}, less ${gap.band} weight」`;
    return line;
  }
  const h = PROMPT_HINTS[gap.metric];
  if (!h) return `${gap.metric} 不达标 → 调整 prompt 后重新生成`;
  const kw = gap.direction === "up" ? h.up : h.down;
  const avoid = AVOID_HINTS[gap.metric];
  return (
    `${gap.metric} 需要${gap.direction === "up" ? "提升" : "降低"} → prompt 加入「${kw}」` +
    (avoid ? `；避免 ${avoid}` : "")
  );
}

/** The global refinement discipline, appended once per refine message. */
export const REFINE_DISCIPLINE =
  "每轮只调一个主要方向（其它 prompt 内容保持不变），这样每轮的 diff 才能归因；" +
  "生成参数（时长/器乐/歌词）除非目标涉及，否则保持与上一轮一致。";
