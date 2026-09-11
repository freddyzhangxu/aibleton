import { AUDIO_PROVIDER_NAMES } from "../audiogen.js";
import { postconditionsFor } from "../verify/rules.js";
import { runVerification } from "../verify/verifier.js";
import type { ProbeSong } from "../verify/types.js";
import { toolHooks, toolState, type Ctx } from "../state.js";

/** Tools that never touch the Set — always allowed, even with YOLO off.
 * web_search/web_fetch are read-only: free, keyless, and they touch nothing
 * local. update_memory only rewrites the user's own memory.json — local,
 * free and trivially reversible, so it needs no confirmation either. */
export const READ_ONLY_TOOLS = new Set([
  "get_song_overview",
  "analyze_song",
  "set_goal",
  "set_plan",
  "update_memory",
  "get_device_parameters",
  "get_clip_notes",
  "search_samples",
  "web_search",
  "web_fetch",
  "move_status",
  "move_pair",
  "move_list_sets",
  "move_list_files",
  "move_analyze_set",
]);

/**
 * Tools that spend real money (API credits). YOLO exempts Set-modifying
 * tools from confirmation, but never these — a billing action always asks.
 */
export const COSTLY_TOOLS = new Set(["generate_audio"]);

/** What a costly tool call will spend, shown in the confirm bar. */
export function costlyDetail(
  name: string,
  input: Record<string, unknown>,
): { provider: string; duration: number } | undefined {
  if (!COSTLY_TOOLS.has(name)) return undefined;
  return {
    provider: toolState.activeAudioConfig ? AUDIO_PROVIDER_NAMES[toolState.activeAudioConfig.provider] : "?",
    duration: Math.min(190, Math.max(1, Number(input.duration_seconds ?? 8) || 8)),
  };
}

/**
 * A tool call waiting for the user's Allow/Deny click in the UI (YOLO off).
 * The UI polls /api/status for it and answers via POST /api/confirm.
 */
let pendingConfirm: {
  tool: string;
  input: unknown;
  costly?: { provider: string; duration: number };
  resolve: (allow: boolean) => void;
} | null = null;

/** Ask the user before a Set-modifying tool call; false = denied or timed out. */
export function askConfirmation(
  tool: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Safety net: a forgotten dialog must not wedge the background task forever.
    const timer = setTimeout(() => {
      pendingConfirm = null;
      resolve(false);
    }, 300_000);
    pendingConfirm = {
      tool,
      input,
      costly: costlyDetail(tool, input),
      resolve: (allow) => {
        clearTimeout(timer);
        pendingConfirm = null;
        resolve(allow);
      },
    };
  });
}

/** Run one tool call and normalize the result for the provider + UI log. */
/**
 * Deterministic postcondition verification (verify/). After a mutating tool
 * succeeds, checks derived from the call itself are probed against the live
 * Set. Failure keeps the result fields (what actually happened) but adds an
 * `error` key — weak models react to structural errors far more reliably than
 * to advisory text. Never throws: a verifier bug must not fail a working call.
 */
export async function verifyToolResult(
  context: Ctx,
  name: string,
  input: Record<string, unknown>,
  result: unknown,
): Promise<unknown> {
  if (typeof result !== "object" || result === null || "error" in result) return result;
  try {
    const specs = postconditionsFor(name, input, result as Record<string, unknown>);
    if (!specs.length) return result;
    // SDK classes carry protected members — the structural ProbeSong view
    // requires one explicit cast here at the boundary.
    const v = await runVerification(context.application.song as unknown as ProbeSong, specs);
    if (v.success) return { ...(result as Record<string, unknown>), verified: true };
    toolHooks.debugLog(context, `VERIFY FAILED ${name}: ${v.remainingIssues.join("；")}`);
    return {
      ...(result as Record<string, unknown>),
      verified: false,
      error:
        `验证失败（操作已执行，未达预期）: ${v.remainingIssues.join("；")}。` +
        `请勿直接重复该操作（避免重复创建内容），按实际状态修正。`,
    };
  } catch (err) {
    toolHooks.debugLog(context, `VERIFY skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}

/** Public view of the pending confirmation for /api/status. */
export function getPendingConfirm():
  | { tool: string; input: unknown; costly?: { provider: string; duration: number } }
  | null {
  return pendingConfirm
    ? { tool: pendingConfirm.tool, input: pendingConfirm.input, costly: pendingConfirm.costly }
    : null;
}

/** Resolve the pending confirmation (Allow/Deny click, or stop/error cleanup).
 * Returns false when nothing was waiting. */
export function answerConfirmation(allow: boolean): boolean {
  if (!pendingConfirm) return false;
  pendingConfirm.resolve(allow);
  return true;
}
