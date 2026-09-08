/**
 * verify/types.ts — deterministic postcondition verification.
 *
 * After a mutating tool runs, checks derived from the tool call ITSELF (its
 * input + the result it reported — never from the user's prose) are probed
 * against the live Set. Pass/fail only: no scoring, no model judgement. A
 * failed check turns the tool result into a structured error the relay model
 * can act on (see callTool in server.ts).
 *
 * Probe* are minimal structural views of the Live SDK objects so plain-data
 * fixtures can stand in offline (SDK classes carry protected members, so
 * server.ts casts `song as unknown as ProbeSong` once at the boundary).
 * Bridge numeric getters may return BigInt on real Live — probes must
 * normalize through toNum() (verifier.ts) before arithmetic.
 */

export interface ProbeParam {
  name: string;
  valueItems?: { name: string }[];
  getValue(): Promise<unknown>;
}

export interface ProbeDevice {
  name: string;
  parameters: ProbeParam[];
}

export interface ProbeClip {
  name: string;
  startTime: number; // arrangement position in beats
  duration: number; // beats
  notes?: unknown[]; // MidiClip only — absent on audio clips
}

export interface ProbeTrack {
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  devices: ProbeDevice[];
  mixer: { volume: ProbeParam; panning: ProbeParam };
  arrangementClips: ProbeClip[];
  clipSlots: { clip: ProbeClip | null }[];
}

export interface ProbeSong {
  tempo: number;
  tracks: ProbeTrack[];
}

export interface ProbeOutcome {
  passed: boolean;
  actual?: string;
}

/** One deterministic check. `expected`/`actual` are human-readable — they land
 * verbatim in the tool result the model reads. */
export interface CheckSpec {
  id: string;
  expected: string;
  probe: (song: ProbeSong) => ProbeOutcome | Promise<ProbeOutcome>;
}

export interface VerificationCheck {
  id: string;
  passed: boolean;
  expected: string;
  actual?: string;
}

export interface VerificationResult {
  success: boolean;
  checks: VerificationCheck[];
  remainingIssues: string[];
}

/** Derives postconditions from a tool call's input and its reported result.
 * Prefer `result` fields over `input`: the tool has already resolved fuzzy
 * references (device/param names) and clamped values, so its report is the
 * exact statement of intent to verify against. */
export type PostconditionRule = (
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) => CheckSpec[];
