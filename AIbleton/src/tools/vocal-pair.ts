import * as fs from "node:fs";
import * as path from "node:path";
import { AudioClip, AudioTrack } from "@ableton-extensions/sdk";
import { featuresFromBuffer, type AudioFeatures } from "../dsp.js";
import { compareVocalFeatures } from "../music/vocal/compare.js";
import type { VocalComparison } from "../music/vocal/types.js";
import { readHomeBinary } from "../paths.js";
import type { Ctx } from "../state.js";
import { resolveTrack, type TrackRef } from "./helpers.js";

const MAX_READ_BYTES = 300 * 1024 * 1024;
const MAX_SECONDS = 180;
const SOURCE_CAVEAT = `When available, measurements describe source-file audio capped at the first ${MAX_SECONDS} seconds per file, pre-warp, pre-gain and pre-device. Clip trimming, automation and existing effects are not measured. Vocal cues are screening candidates, not diagnoses; no note-level pitch or timing comparison was made.`;

type SourceStatus = "ok" | "unreadable" | "unsupported" | "silent" | "analysis_error";

export interface VocalSourceResult {
  track?: string;
  track_index?: number;
  clip_index?: number;
  clip?: string;
  file: string;
  status: SourceStatus;
  partial?: true;
  error?: string;
}

export interface VocalComparisonToolResult {
  comparison: "source_file";
  analysis_limit_seconds: number;
  recorded: VocalSourceResult;
  reference: VocalSourceResult;
  measurements?: VocalComparison;
  caveat: string;
}

interface SourceSelection {
  filePath: string;
  track?: string;
  trackIndex?: number;
  clipIndex?: number;
  clip?: string;
}

/** A silent analyzed prefix cannot establish that an unmeasured tail is silent. */
export function classifyVocalFeatures(features: AudioFeatures): Pick<VocalSourceResult, "status" | "partial" | "error"> {
  if (features.peakDb <= -90) {
    return features.partial
      ? { status: "analysis_error", partial: true, error: "analyzed portion is silent; the rest of the source was not measured" }
      : { status: "silent", error: "source audio is silent" };
  }
  return { status: "ok", ...(features.partial ? { partial: true as const } : {}) };
}

function audioTrack(ref: TrackRef): AudioTrack<"1.0.0"> {
  if (!(ref.track instanceof AudioTrack)) {
    throw new Error(`Track ${ref.index} (${ref.track.name}) is not an Audio Track`);
  }
  return ref.track;
}

function selectTrackSource(ref: TrackRef, rawClipIndex: unknown, role: "recorded" | "reference"): SourceSelection {
  const track = audioTrack(ref);
  const clips = track.arrangementClips;
  const eligible = clips.map((clip, index) => ({ clip, index })).filter(({ clip }) =>
    clip instanceof AudioClip && !clip.muted && typeof clip.filePath === "string" && !!clip.filePath.trim(),
  );
  let selected: { clip: AudioClip<"1.0.0">; index: number };
  if (rawClipIndex !== undefined) {
    const index = Number(rawClipIndex);
    if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
      throw new Error(`${role}_clip_index must identify an existing arrangement Audio Clip`);
    }
    const clip = clips[index];
    if (!(clip instanceof AudioClip) || clip.muted || typeof clip.filePath !== "string" || !clip.filePath.trim()) {
      throw new Error(`${role}_clip_index does not identify an unmuted Audio Clip with readable source audio`);
    }
    selected = { clip, index };
  } else {
    if (eligible.length === 0) {
      throw new Error(`Track ${ref.index} (${track.name}) has no readable arrangement Audio Clip; Session-only clips are unsupported for vocal source comparison`);
    }
    if (eligible.length > 1) throw new Error(`Track ${ref.index} (${track.name}) has multiple vocal clips; provide ${role}_clip_index for the matching passage`);
    selected = eligible[0] as { clip: AudioClip<"1.0.0">; index: number };
  }
  return {
    filePath: selected.clip.filePath,
    track: track.name,
    trackIndex: ref.index,
    clipIndex: selected.index,
    clip: selected.clip.name,
  };
}

async function analyzeSource(source: SourceSelection): Promise<{ summary: VocalSourceResult; features?: AudioFeatures }> {
  const base: VocalSourceResult = {
    ...(source.track !== undefined ? { track: source.track, track_index: source.trackIndex, clip_index: source.clipIndex, clip: source.clip } : {}),
    file: path.basename(source.filePath),
    status: "ok",
  };
  try {
    const stat = fs.statSync(source.filePath);
    if (stat.size > MAX_READ_BYTES) {
      return { summary: { ...base, status: "analysis_error", error: "source file exceeds 300 MB analysis limit" } };
    }
  } catch {
    // The Extension Host may deny stat while allowing readHomeBinary.
  }
  const bytes = readHomeBinary(source.filePath);
  if (!bytes) return { summary: { ...base, status: "unreadable", error: "source file is missing or cannot be read" } };
  if (bytes.length > MAX_READ_BYTES) {
    return { summary: { ...base, status: "analysis_error", error: "source file exceeds 300 MB analysis limit" } };
  }
  const outcome = await featuresFromBuffer(source.filePath, bytes, { maxSeconds: MAX_SECONDS });
  if ("error" in outcome) {
    const status = outcome.error.startsWith("unknown audio extension") ? "unsupported" : "analysis_error";
    return { summary: { ...base, status, error: outcome.error } };
  }
  const classification = classifyVocalFeatures(outcome.features);
  return {
    summary: { ...base, ...classification },
    ...(classification.status === "ok" ? { features: outcome.features } : {}),
  };
}

/** Inspect two isolated vocal sources without changing the user's Live Set. */
export async function analyzeVocalPair(context: Ctx, input: Record<string, unknown>): Promise<VocalComparisonToolResult> {
  const hasReferenceTrack = input.reference_track_index !== undefined || (typeof input.reference_track_name === "string" && !!input.reference_track_name.trim());
  const hasReferencePath = typeof input.reference_path === "string" && !!input.reference_path.trim();
  if (hasReferenceTrack === hasReferencePath) {
    throw new Error(hasReferenceTrack ? "Provide exactly one reference track or path" : "Provide a reference track or path");
  }
  const recordedRef = resolveTrack(context, {
    track_index: input.recorded_track_index,
    track_name: input.recorded_track_name,
  }, "track_index");
  const recorded = selectTrackSource(recordedRef, input.recorded_clip_index, "recorded");

  let reference: SourceSelection;
  if (hasReferenceTrack) {
    const referenceRef = resolveTrack(context, {
      track_index: input.reference_track_index,
      track_name: input.reference_track_name,
    }, "track_index");
    if (referenceRef.track === recordedRef.track) throw new Error("Recorded and reference vocals must be on different tracks or files");
    reference = selectTrackSource(referenceRef, input.reference_clip_index, "reference");
  } else {
    const filePath = (input.reference_path as string).trim();
    if (!path.isAbsolute(filePath)) throw new Error("reference_path must be an absolute local path");
    reference = { filePath };
  }
  if (path.resolve(reference.filePath) === path.resolve(recorded.filePath)) {
    throw new Error("Recorded and reference vocals must use different tracks or files");
  }
  const [recordedResult, referenceResult] = await Promise.all([
    analyzeSource(recorded),
    analyzeSource(reference),
  ]);
  return {
    comparison: "source_file",
    analysis_limit_seconds: MAX_SECONDS,
    recorded: recordedResult.summary,
    reference: referenceResult.summary,
    ...(recordedResult.features && referenceResult.features
      ? { measurements: compareVocalFeatures(recordedResult.features, referenceResult.features) }
      : {}),
    caveat: SOURCE_CAVEAT,
  };
}
