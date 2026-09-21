import { READ_ONLY_TOOLS } from "./gates.js";
import type { TurnGoalOutcome } from "../agent/turnoutcome.js";
import type { ListenHint } from "../tools/listenhint.js";

export type ToolAction = { tool: string; input: unknown; result: unknown };

export type TurnReceipt = {
  status: "completed" | "passed" | "unmet";
  objective?: string;
  tools: string[];
  listenHints: ListenHint[];
  verification?: string;
  undo: "live_undo";
};

/** These tools can change local/external data but never change the Live Set. */
const NON_SET_MUTATIONS = new Set(["move_upload_sample", "move_download_set"]);

function succeeded(result: unknown): result is Record<string, unknown> {
  return !!result &&
    typeof result === "object" &&
    !("error" in result) &&
    (result as Record<string, unknown>).executed !== false;
}

function setMutation(action: ToolAction): boolean {
  if (!succeeded(action.result) || READ_ONLY_TOOLS.has(action.tool)) return false;
  if (NON_SET_MUTATIONS.has(action.tool)) return false;
  // Audio generation only writes the Set when it imported the new artifact.
  if (action.tool === "generate_audio") return !!action.result.imported;
  return true;
}

function asListenHint(value: unknown): ListenHint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tracks) || !raw.tracks.every((t) => typeof t === "string") || raw.tracks.length === 0) {
    return undefined;
  }
  const hint: ListenHint = { tracks: [...new Set(raw.tracks)] };
  if (typeof raw.start_bar === "number") hint.start_bar = raw.start_bar;
  if (typeof raw.end_bar === "number") hint.end_bar = raw.end_bar;
  if (typeof raw.suggest_solo === "string") hint.suggest_solo = raw.suggest_solo;
  if (raw.suggest_ab === true) hint.suggest_ab = true;
  return hint;
}

function uniqueHints(actions: readonly ToolAction[]): ListenHint[] {
  const out: ListenHint[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (!succeeded(action.result)) continue;
    const hint = asListenHint(action.result.listen_hint);
    if (!hint) continue;
    const key = JSON.stringify(hint);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(hint);
    }
  }
  return out;
}

/**
 * Build a durable receipt strictly from calls that changed the Live Set and
 * from the runtime's measured goal verdict. It is deliberately pure: failed,
 * denied and unknown tool results can never prevent a chat response.
 */
export function buildTurnReceipt(
  actions: readonly ToolAction[],
  outcome?: TurnGoalOutcome,
): TurnReceipt | undefined {
  const mutations = actions.filter(setMutation);
  if (!mutations.length) return undefined;
  const tools = [...new Set(mutations.map((a) => a.tool))];
  return {
    status: outcome?.status ?? "completed",
    ...(outcome?.objective ? { objective: outcome.objective } : {}),
    tools,
    listenHints: uniqueHints(mutations),
    ...(outcome?.verification ? { verification: outcome.verification } : {}),
    undo: "live_undo",
  };
}
