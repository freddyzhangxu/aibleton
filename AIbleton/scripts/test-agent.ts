/**
 * Fixture-based test for src/agent/ (Agent Execution Loop).
 * Run: npx tsx scripts/test-agent.ts
 *
 * The loop's server side is pure (budget accounting + the exit decision), so
 * the whole contract is exercised offline: the gateAction matrix, mutation
 * counting over a tool log, and — the point of the layer — termination
 * invariants for simulated models, including a maximally stubborn one that
 * ignores every refusal. No Live, no SDK, no server.ts imports.
 */
import {
  AGENT_MAX_RETRIES,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_STEPS,
  countMutations,
  gateAction,
  mutationsLeft,
  stepBudgetError,
} from "../src/agent/loop.js";

/** Mirrors server.ts's READ_ONLY_TOOLS for the tools this test logs. */
const READ_ONLY: ReadonlySet<string> = new Set([
  "get_song_overview",
  "analyze_song",
  "set_goal",
  "set_plan",
  "web_search",
]);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failed = 0;
let passed = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (cond) passed++;
  else failed++;
}

// ---------------------------------------------------------------------------
console.log("== 循环上限常量 ==");
{
  check("重试上限恰为 1（PR7 决策：单次 replan）", AGENT_MAX_RETRIES === 1);
  check(
    "步数预算在 5~8 之间（PR7 建议区间）",
    AGENT_MAX_STEPS >= 5 && AGENT_MAX_STEPS <= 8,
    `AGENT_MAX_STEPS=${AGENT_MAX_STEPS}`,
  );
  check(
    "round 兜底大于步数预算（留出分析/声明/收尾的轮次）",
    AGENT_MAX_ROUNDS > AGENT_MAX_STEPS,
    `rounds=${AGENT_MAX_ROUNDS} steps=${AGENT_MAX_STEPS}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== gateAction 出口判定矩阵 ==");
{
  check("目标达成 → pass（无视剩余预算/重试次数）", gateAction(true, 0, 0) === "pass");
  check("未达成 + 有重试 + 有预算 → retry", gateAction(false, 0, 3) === "retry");
  check(
    "未达成 + 重试已用完 → stop",
    gateAction(false, AGENT_MAX_RETRIES, 5) === "stop",
  );
  check(
    "未达成 + 预算为 0 → stop（没有预算的 retry 只会空转）",
    gateAction(false, 0, 0) === "stop",
  );
  check("预算为负同样 → stop", gateAction(false, 0, -2) === "stop");
}

// ---------------------------------------------------------------------------
console.log("== 改动预算计数 ==");
{
  const log = [
    "set_goal", // meta — 不占预算
    "analyze_song", // 只读
    "set_plan", // meta
    "create_midi_track", // 改动 1
    "web_search", // 只读
    "write_midi_clip", // 改动 2
    "write_midi_clip", // 改动 3（每次执行都计）
    "get_song_overview", // 只读
  ];
  check("混合日志只计修改类调用（3 次）", countMutations(log, READ_ONLY) === 3);
  check(
    "剩余预算 = 上限 − 已执行",
    mutationsLeft(log, READ_ONLY) === AGENT_MAX_STEPS - 3,
  );
  const over = Array(AGENT_MAX_STEPS + 4).fill("write_midi_clip");
  check("超出后剩余预算钳到 0（不为负）", mutationsLeft(over, READ_ONLY) === 0);
}

// ---------------------------------------------------------------------------
console.log("== 预算拒绝的结构化 error ==");
{
  const err = stepBudgetError();
  check("带 error 键（弱模型对结构错误最敏感）", typeof err.error === "string" && err.error.length > 0);
  check("带 budget_exhausted 标记", err.budget_exhausted === true);
  check("消息含预算数值与「未执行」语义", String(err.error).includes(String(AGENT_MAX_STEPS)) && String(err.error).includes("NOT executed"));
}

// ---------------------------------------------------------------------------
// Termination simulation — server.ts's turn re-played against the pure rules.
// The model is a strategy function; the server side is exactly agent/loop.ts:
// budget refusal before execution, gateAction at text-exit, round backstop.
// ---------------------------------------------------------------------------

interface SimResult {
  mutations: number; // executed Set-mutating calls
  retries: number; // goal-gate retries injected
  refusedCalls: number; // budget refusals (never executed)
  rounds: number;
  ended: "pass" | "stop-note" | "round-cap";
}

function simulate(
  model: (s: { round: number; lastRefused: boolean; retries: number; mutations: number }) => "mutate" | "exit",
  metWhen: (mutations: number) => boolean,
): SimResult {
  const executed: string[] = [];
  let retries = 0;
  let refusedCalls = 0;
  let lastRefused = false;
  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    const choice = model({ round, lastRefused, retries, mutations: executed.length });
    if (choice === "mutate") {
      if (countMutations(executed, READ_ONLY) >= AGENT_MAX_STEPS) {
        refusedCalls++; // server returns stepBudgetError() — NOT executed
        lastRefused = true;
      } else {
        executed.push("write_midi_clip");
        lastRefused = false;
      }
      continue;
    }
    // Text-exit → the goal gate decides (agent/loop.ts's pure contract).
    const action = gateAction(metWhen(executed.length), retries, mutationsLeft(executed, READ_ONLY));
    if (action === "pass") return { mutations: executed.length, retries, refusedCalls, rounds: round + 1, ended: "pass" };
    if (action === "stop") return { mutations: executed.length, retries, refusedCalls, rounds: round + 1, ended: "stop-note" };
    retries++;
    lastRefused = false;
  }
  return { mutations: executed.length, retries, refusedCalls, rounds: AGENT_MAX_ROUNDS, ended: "round-cap" };
}

console.log("== 终止性：达成目标的正常回合 ==");
{
  const r = simulate(
    ({ mutations }) => (mutations < 3 ? "mutate" : "exit"),
    () => true, // 三次改动后目标达成
  );
  check("目标达成即 pass，不重试", r.ended === "pass" && r.retries === 0, JSON.stringify(r));
  check("只执行了需要的 3 次改动", r.mutations === 3);
}

console.log("== 终止性：未达成 → 恰好一次 replan → 结账退出 ==");
{
  let exits = 0;
  const r = simulate(
    ({ mutations, retries }) => {
      if (retries === 0 && mutations < 3) return "mutate";
      if (retries === 1 && mutations < 5) return "mutate";
      exits++;
      return "exit";
    },
    () => false, // 目标始终未达成
  );
  check("重试恰好 1 次（AGENT_MAX_RETRIES）", r.retries === 1, JSON.stringify(r));
  check("最终以实测 note 收尾", r.ended === "stop-note");
  check("两轮共 5 次改动，无预算拒绝", r.mutations === 5 && r.refusedCalls === 0);
  check("模型确实退出过两次（每次退出都过了 gate）", exits === 2);
}

console.log("== 终止性：预算耗尽时未达成 → 不再 retry，直接结账 ==");
{
  const r = simulate(
    ({ lastRefused }) => (lastRefused ? "exit" : "mutate"), // 守规矩：被拒就收尾
    () => false,
  );
  check("改动数恰好停在预算上限", r.mutations === AGENT_MAX_STEPS, JSON.stringify(r));
  check("发生 1 次预算拒绝", r.refusedCalls === 1);
  check(
    "预算为 0 的 gate 直接 stop（不浪费唯一一次 retry）",
    r.ended === "stop-note" && r.retries === 0,
  );
}

console.log("== 终止性：最顽固模型（无视拒绝永远尝试改动）也不会失控 ==");
{
  const r = simulate(
    () => "mutate", // 永不退出、永不停手
    () => false,
  );
  check("改动数永远不超预算", r.mutations === AGENT_MAX_STEPS, JSON.stringify(r));
  check(
    "之后的每次尝试都被拒绝且未执行",
    r.refusedCalls === AGENT_MAX_ROUNDS - AGENT_MAX_STEPS,
  );
  check("最终撞 round 兜底中止 — 不存在无限 ReAct", r.ended === "round-cap" && r.rounds === AGENT_MAX_ROUNDS);
  check("全程未注入 retry（gate 从未被触发）", r.retries === 0);
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 项失败 / ${passed + failed}` : `\n全部通过 (${passed})`);
process.exit(failed ? 1 : 0);
