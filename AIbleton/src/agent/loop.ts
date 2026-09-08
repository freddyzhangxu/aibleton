/**
 * agent/loop.ts — the Agent Execution Loop: one bounded goal-cycle per turn.
 *
 * PR5 declared WHAT "done" means (goal/), PR6 declared the route (plan/),
 * PR4 checked each landing (verify/). This layer binds them into the loop:
 *
 *   before = snapshot            → set_goal captures the baseline GoalView
 *   plan   = createPlan(before)  → set_plan attaches ordered steps
 *   for step: execute(step)      → the relay model drives tool calls; the
 *                                  server verifies each one post-hoc (verify/)
 *   after  = snapshot            → goalGate rebuilds the GoalView at text-exit
 *   result = verifyGoal(...)     → evaluateGoal + buildPlanReport
 *   if (!result.success) replan  → ONE bounded retry, then stop either way
 *
 * The model drives; this module owns the BOUNDS. Music is not code: "better"
 * is not deterministic, so an unbounded ReAct loop (tweak → doubt → tweak →
 * re-analyze → tweak) drifts the Set away from anything the user asked for.
 * Three hard limits, all per user turn:
 *
 *   AGENT_MAX_STEPS   — executed Set-mutating calls. Hit it and further
 *                       mutations are refused UNEXECUTED (before the user is
 *                       even asked to confirm); the model must summarize and
 *                       let the user say "continue" — a fresh turn is a fresh
 *                       budget, i.e. a human checkpoint.
 *   AGENT_MAX_RETRIES — goal-gate replans. Exactly one: diagnose the failed
 *                       gate against the plan, clear the plan, repair, final
 *                       judgement. Never an open-ended loop.
 *   AGENT_MAX_ROUNDS  — provider-round backstop behind everything (each
 *                       provider's chat loop caps at this many LLM calls).
 *
 * Everything here is pure over plain data — the turn state (executed tool
 * log, retry counter) lives in server.ts, which consults these functions at
 * the two decision points: before running a mutating tool (budget) and at
 * the loop's text-exit (gate).
 */

/** Provider-round backstop — replaces the literal `12` in each chat loop. */
export const AGENT_MAX_ROUNDS = 12;

/**
 * Hard cap on EXECUTED Set-mutating calls per turn. Deliberately small: a
 * focused goal needs a handful of landings (create → load → write → tweak),
 * and a model that needs more is flailing, not finishing. Verify-failed calls
 * consume budget too (they DID mutate the Set — "executed but missed target"
 * is still a change the next call must reckon with); denied/thrown calls
 * never executed and cost nothing.
 */
export const AGENT_MAX_STEPS = 8;

/** Goal-gate replans per turn. One — see the header. */
export const AGENT_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// The exit decision, as one pure function.
// ---------------------------------------------------------------------------

export type GateAction =
  | "pass" // goal met (or none pending) — let the turn finish
  | "retry" // inject the diagnosis and continue the loop once
  | "stop"; // finish with the measured-outcome note

/**
 * What the loop should do at a text-exit, given the goal verdict, how many
 * retries already happened, and how much mutation budget remains.
 *
 * The third rule is the one that keeps the loop honest: a retry with no
 * mutation budget left could only re-analyze and apologize — that is a stop
 * with the measured note, not another round.
 */
export function gateAction(met: boolean, retries: number, mutationsLeft: number): GateAction {
  if (met) return "pass";
  if (retries >= AGENT_MAX_RETRIES) return "stop";
  if (mutationsLeft <= 0) return "stop";
  return "retry";
}

// ---------------------------------------------------------------------------
// Budget accounting over the turn's executed-tool log.
// ---------------------------------------------------------------------------

/**
 * Count the log entries that mutated the Set. `readOnly` is the server's
 * READ_ONLY_TOOLS set — it already contains the meta tools (set_goal /
 * set_plan), so intent declarations never consume budget.
 */
export function countMutations(executedTools: readonly string[], readOnly: ReadonlySet<string>): number {
  let n = 0;
  for (const t of executedTools) if (!readOnly.has(t)) n++;
  return n;
}

/** Remaining mutation budget this turn (never negative). */
export function mutationsLeft(executedTools: readonly string[], readOnly: ReadonlySet<string>): number {
  return Math.max(0, AGENT_MAX_STEPS - countMutations(executedTools, readOnly));
}

/**
 * The structured tool result for a call refused by the step budget. An
 * `error` key, same as verify/'s failures — weak models react to structural
 * errors far more reliably than to advisory text. The message orders the
 * wrap-up explicitly so the model doesn't burn its remaining rounds re-trying.
 */
export function stepBudgetError(): Record<string, unknown> {
  return {
    error:
      `本回合改动预算已用完（${AGENT_MAX_STEPS} 次修改类调用），该调用未执行。` +
      `请停止修改，总结已完成的改动与未完成的部分，由用户决定是否继续（新回合会有新预算）。` +
      ` / Turn mutation budget exhausted (${AGENT_MAX_STEPS} mutating calls executed) — this call was NOT executed. ` +
      `Stop modifying, summarize what landed vs. what remains, and let the user decide whether to continue.`,
    budget_exhausted: true,
  };
}
