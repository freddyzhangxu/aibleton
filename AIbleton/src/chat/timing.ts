/** Prefer the Extension Host's monotonic high-resolution clock; keep the
 * fallback for older Live runtimes and non-Live test environments. */
export function monotonicNow(): number {
  const clock = globalThis.performance;
  return clock && typeof clock.now === "function" ? clock.now() : Date.now();
}

/** Measure an async stage without allowing best-effort diagnostics to affect
 * the operation's result or error. */
export async function measureAsync<T>(
  label: string,
  operation: () => Promise<T>,
  log: (line: string) => void,
  now: () => number = monotonicNow,
): Promise<T> {
  const startedAt = now();
  let outcome: "ok" | "error" = "ok";
  try {
    return await operation();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    const elapsedMs = Math.max(0, now() - startedAt).toFixed(1);
    try {
      log(`TIMING ${label} elapsedMs=${elapsedMs} outcome=${outcome}`);
    } catch {
      // Diagnostics are best effort and must not mask the operation outcome.
    }
  }
}
