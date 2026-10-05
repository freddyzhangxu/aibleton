/**
 * Timeout deadlines shared by websearch / move / updatecheck.
 *
 * The current Extensions SDK exposes the AbortSignal global in the sandbox,
 * so AbortSignal.timeout/any do the job natively; older Live runtimes still
 * throw "AbortSignal is not defined" on a bare reference, so the fallback
 * keeps the proven AbortController + setTimeout pattern. Runtime access goes
 * through globalThis — never a bare `AbortSignal` identifier — and esbuild's
 * per-module isolation means every module that needs URL/Buffer imports it
 * itself (this one needs neither).
 */

interface NativeAbortSignalStatic {
  timeout?(ms: number): AbortSignal;
  any?(signals: AbortSignal[]): AbortSignal;
}

const Native = (globalThis as { AbortSignal?: NativeAbortSignalStatic }).AbortSignal;
const canNative = typeof Native?.timeout === "function" && typeof Native?.any === "function";

export interface Deadline {
  signal: AbortSignal;
  /** true when OUR timer (not the caller's stop signal) aborted the request. */
  timedOut: () => boolean;
  dispose: () => void;
}

/** Caller-stop abort + a hard per-call ceiling, whichever fires first. */
export function withDeadline(parent: AbortSignal | undefined, ms: number): Deadline {
  if (canNative) {
    const timeout = Native!.timeout!(ms);
    return {
      signal: parent ? Native!.any!([parent, timeout]) : timeout,
      timedOut: () => timeout.aborted,
      dispose: () => {},
    };
  }
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ctl.abort();
  }, ms);
  // Don't hold the host process open for a leftover timer (native
  // AbortSignal.timeout is unref'd by the runtime).
  if (typeof timer.unref === "function") timer.unref();
  const onAbort = () => ctl.abort();
  if (parent) {
    if (parent.aborted) ctl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => fired,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
