/**
 * verify/verifier.ts — runs CheckSpecs against the live Set.
 *
 * A probe that throws means "could not verify" (the object vanished, the
 * bridge hiccuped) — recorded as a failed check with the error as `actual`,
 * so the failure surfaces to the model instead of being swallowed.
 */

import type { CheckSpec, ProbeSong, VerificationCheck, VerificationResult } from "./types.js";

/** The Extension Host bridge hands back BigInt for some numeric getters
 * (confirmed on real Live 12.4.5) — normalize every number crossing it. */
export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v as number);
  return Number.isFinite(n) ? n : fallback;
}

export async function runVerification(
  song: ProbeSong,
  specs: CheckSpec[],
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  for (const spec of specs) {
    try {
      const out = await spec.probe(song);
      checks.push({ id: spec.id, passed: out.passed, expected: spec.expected, actual: out.actual });
    } catch (err) {
      checks.push({
        id: spec.id,
        passed: false,
        expected: spec.expected,
        actual: `probe 异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const remainingIssues = checks
    .filter((c) => !c.passed)
    .map((c) => `${c.id}: 期望 ${c.expected}${c.actual ? `，实际 ${c.actual}` : ""}`);
  return { success: remainingIssues.length === 0, checks, remainingIssues };
}
