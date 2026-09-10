/**
 * genlog/store.ts — persistence for the generation registry.
 *
 * Lives next to the generated files: <User Library>/AIbleton/genlog.json —
 * a sibling of providers.json in spirit (server-side durable state; the
 * webview's localStorage is not). All fs goes through paths.js's
 * sandbox-surviving primitives, so the installed Extension Host
 * (node --permission, home dir denied) works exactly like dev mode.
 *
 * The log is append-only and bounded (FIFO prune) — a corrupt or missing
 * file reads as an empty log, never an exception: generation itself must
 * never fail because bookkeeping did.
 */

import * as path from "node:path";
import { generatedAudioDir, type AudioProvider } from "../audiogen.js";
import { featuresFromBuffer } from "../dsp.js";
import { mkdirOutsideSandbox, readHomeBinary, readHomeFile, writeHomeFile } from "../paths.js";
import type { GenLogFile, GenerationParams, GenerationRecord } from "./types.js";

const GENLOG_NAME = "genlog.json";
/** Generations are a few KB of JSON each; 200 covers months of refining. */
export const GENLOG_MAX_RECORDS = 200;

export function genlogPath(dir: string = generatedAudioDir()): string {
  return path.join(dir, GENLOG_NAME);
}

/** Missing or corrupt file → empty log (never throws). */
export function loadGenLog(dir: string = generatedAudioDir()): GenerationRecord[] {
  const text = readHomeFile(genlogPath(dir));
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as GenLogFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return [];
    return parsed.records;
  } catch {
    return [];
  }
}

/** Newest record, or undefined when the log is empty. */
export function latestGeneration(dir: string = generatedAudioDir()): GenerationRecord | undefined {
  return loadGenLog(dir).at(-1);
}

/** Append one record and prune to the FIFO cap. Returns the full log. */
export function appendGeneration(
  record: GenerationRecord,
  dir: string = generatedAudioDir(),
): GenerationRecord[] {
  const records = [...loadGenLog(dir), record].slice(-GENLOG_MAX_RECORDS);
  const file: GenLogFile = { version: 1, records };
  mkdirOutsideSandbox(dir);
  writeHomeFile(genlogPath(dir), JSON.stringify(file, null, 2));
  return records;
}

export interface RecordGenerationInput {
  file: string;
  provider: AudioProvider;
  prompt: string;
  params: GenerationParams;
  iterationOf?: string;
}

/**
 * Build the record for a just-generated file — read the bytes back through
 * the sandbox escape, decode features immediately (later refine rounds then
 * diff from the log without re-reading audio) — and append it.
 *
 * Decode failures are recorded (featuresError), not thrown: an mp3 from
 * ElevenLabs is a perfectly good generation, just not analyzable by dsp.ts.
 */
export function recordGeneration(
  input: RecordGenerationInput,
  dir: string = generatedAudioDir(),
): GenerationRecord {
  const record: GenerationRecord = {
    id: path.basename(input.file).replace(/\.[^.]+$/, ""),
    file: input.file,
    provider: input.provider,
    prompt: input.prompt,
    params: input.params,
    createdAt: new Date().toISOString(),
    ...(input.iterationOf ? { iterationOf: input.iterationOf } : {}),
  };
  const buf = readHomeBinary(input.file);
  if (!buf) {
    record.featuresError = "unreadable (missing or denied)";
  } else {
    const outcome = featuresFromBuffer(input.file, buf);
    if ("features" in outcome) record.features = outcome.features;
    else record.featuresError = outcome.error;
  }
  appendGeneration(record, dir);
  return record;
}
