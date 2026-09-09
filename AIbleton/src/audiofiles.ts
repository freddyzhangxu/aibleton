/**
 * audiofiles.ts — audio clip source files → DSP features, with caching.
 *
 * The impure counterpart of dsp.ts: resolves each audio clip's filePath,
 * reads the bytes via paths.readHomeBinary (survives the installed Extension
 * Host sandbox), decodes/analyzes via dsp.ts, and caches the result by
 * path+mtime+size for the process lifetime (the paths.ts module-level-Map
 * idiom — no disk cache, no invalidation protocol).
 *
 * Guards: files > 300 MB are rejected WITHOUT reading (readHomeBinary's
 * base64 escape caps at a 256 MB maxBuffer); files > 150 MB or longer
 * than 8 min are analyzed for their first 3 minutes and marked partial.
 * When the sandbox denies statSync the cache degrades to path+size keying —
 * a mid-session rewrite of identical size would serve stale features;
 * documented, acceptable.
 *
 * enrichMusicStateWithAudio mutates the freshly-built MusicState's ClipState
 * objects in place (they are owned by the caller) and NEVER throws — every
 * per-file failure becomes a structured error on the clip.
 *
 * Future work: move_analyze_set builds from an in-memory .ablbundle whose
 * audio entries are already Buffers — featuresFromBuffer could analyze them
 * with no filesystem at all (bundle plumbing needed, not wired yet).
 */

import * as fs from "node:fs";
import type { AudioEnrichStats } from "./analysis/types.js";
import { featuresFromBuffer, type AudioFeatures } from "./dsp.js";
import type { ClipState, MusicState } from "./musicstate/types.js";
import { readHomeBinary } from "./paths.js";

const MAX_READ_BYTES = 300 * 1024 * 1024; // reject without reading
const TRUNCATE_BYTES = 150 * 1024 * 1024; // read but analyze a prefix
const MAX_SECONDS_FULL = 8 * 60;
const TRUNCATE_SECONDS = 3 * 60;

type FeatureOutcome = { features: AudioFeatures } | { error: string };

interface CacheEntry {
  mtimeMs: number; // 0 = stat denied (sandbox) — keying degrades to path+size
  size: number;
  outcome: FeatureOutcome;
}

const featureCache = new Map<string, CacheEntry>();

function statOf(p: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // denied (sandbox) or genuinely missing — read decides
  }
}

function cacheHit(p: string, mtimeMs: number, size: number | null): FeatureOutcome | null {
  const e = featureCache.get(p);
  if (!e || e.mtimeMs !== mtimeMs) return null;
  if (size !== null && e.size !== size) return null;
  return e.outcome;
}

function analyzeAudioFile(p: string): { outcome: FeatureOutcome; fromCache: boolean } {
  const st = statOf(p);
  const mtimeMs = st?.mtimeMs ?? 0;
  if (st && st.size > MAX_READ_BYTES) {
    return { outcome: { error: "file too large (> 300 MB)" }, fromCache: false };
  }

  const hit = cacheHit(p, mtimeMs, st?.size ?? null);
  if (hit) return { outcome: hit, fromCache: true };

  const buf = readHomeBinary(p);
  if (!buf) {
    const outcome: FeatureOutcome = { error: "unreadable (missing or denied)" };
    featureCache.set(p, { mtimeMs, size: st?.size ?? 0, outcome });
    return { outcome, fromCache: false };
  }
  if (buf.length > MAX_READ_BYTES) {
    return { outcome: { error: "file too large (> 300 MB)" }, fromCache: false };
  }

  const maxSeconds = buf.length > TRUNCATE_BYTES ? TRUNCATE_SECONDS : MAX_SECONDS_FULL;
  const outcome = featuresFromBuffer(p, buf, { maxSeconds });
  featureCache.set(p, { mtimeMs, size: buf.length, outcome });
  return { outcome, fromCache: false };
}

export interface EnrichOptions {
  maxFiles?: number; // unique paths decoded per run (default 40)
  timeBudgetMs?: number; // wall-clock budget (default 20000)
}

/**
 * Fill ClipState.audio for every audible arrangement audio clip with a
 * filePath: unmuted track, unmuted arrangement clip — the same predicate
 * interpret.aggregateTrackAudio and present.ts's audio block use, so a
 * computed feature always aggregates and an aggregated feature is always
 * audible. Same file referenced by N clips decodes once.
 */
export async function enrichMusicStateWithAudio(
  state: MusicState,
  opts?: EnrichOptions,
): Promise<AudioEnrichStats> {
  const maxFiles = opts?.maxFiles ?? 40;
  const timeBudgetMs = opts?.timeBudgetMs ?? 20000;
  const stats: AudioEnrichStats = { computed: 0, cached: 0, failed: 0, skipped: 0 };

  const eligible = (ts: MusicState["tracks"][number], cs: ClipState): cs is ClipState & { clip: { filePath: string } } =>
    !ts.muted && cs.clip.kind === "audio" && cs.clip.start !== null && !cs.clip.muted && !!cs.clip.filePath;

  const outcomes = new Map<string, FeatureOutcome>();
  const t0 = Date.now();
  let budgetExhausted = false;
  for (const ts of state.tracks) {
    for (const cs of ts.clips) {
      if (!eligible(ts, cs)) continue;
      const p = cs.clip.filePath;
      let outcome = outcomes.get(p);
      if (outcome === undefined) {
        if (budgetExhausted || outcomes.size >= maxFiles || Date.now() - t0 > timeBudgetMs) {
          budgetExhausted = true;
          stats.skipped++;
          continue;
        }
        try {
          const r = analyzeAudioFile(p);
          outcome = r.outcome;
          if ("error" in outcome) stats.failed++;
          else if (r.fromCache) stats.cached++;
          else stats.computed++;
        } catch (e) {
          outcome = { error: `analysis failed: ${e instanceof Error ? e.message : String(e)}` };
          stats.failed++;
        }
        outcomes.set(p, outcome);
      } else {
        // Same file referenced by another clip: shared outcome, no re-decode.
        if ("error" in outcome) stats.failed++;
        else stats.cached++;
      }
      cs.audio = "error" in outcome ? { error: outcome.error } : { features: outcome.features };
    }
  }
  return stats;
}
