/**
 * genlog/types.ts — the generation registry record.
 *
 * One record per generate_audio call: what was asked (prompt/params), what
 * came back (file), and what it sounds like (features, decoded right after
 * generation so a later refine round never re-reads the bytes).
 *
 * Honesty rule (same as the reference-gap layer): features are absent when
 * the file could not be decoded — ElevenLabs returns mp3, which dsp.ts does
 * not decode — and featuresError says why. Absent means UNKNOWN, never zero.
 *
 * iterationOf is the lineage hook reserved for the refine loop (PR19):
 * iterations of one goal share a lineage id; standalone generations leave it
 * undefined.
 */

import type { AudioProvider } from "../audiogen.js";
import type { AudioFeatures } from "../dsp.js";

export interface GenerationParams {
  seconds: number;
  instrumental?: boolean;
  lyrics?: string;
}

export interface GenerationRecord {
  /** File basename without extension — stable, unique, human-traceable. */
  id: string;
  file: string;
  provider: AudioProvider;
  prompt: string;
  params: GenerationParams;
  /** ISO timestamp. */
  createdAt: string;
  features?: AudioFeatures;
  /** Why features are absent (decode failure / unsupported format). */
  featuresError?: string;
  /** Refine-lineage id (PR19); undefined for one-off generations. */
  iterationOf?: string;
}

/** On-disk shape of genlog.json. */
export interface GenLogFile {
  version: 1;
  records: GenerationRecord[];
}
