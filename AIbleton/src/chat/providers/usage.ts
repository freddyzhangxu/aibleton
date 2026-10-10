import { toolHooks, type Ctx } from "../../state.js";

export type ProviderTokenUsage = Record<string, unknown>;

function tokenCount(usage: ProviderTokenUsage, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** Log provider-reported token counts when an endpoint exposes them. */
export function logProviderUsage(
  context: Ctx,
  provider: string,
  round: number,
  usage: ProviderTokenUsage | undefined,
): void {
  if (!usage) return;
  const input = tokenCount(usage, ["input_tokens", "prompt_tokens", "promptTokenCount"]);
  const output = tokenCount(usage, ["output_tokens", "completion_tokens", "candidatesTokenCount"]);
  const total = tokenCount(usage, ["total_tokens", "totalTokenCount"]);
  const cachedInput = tokenCount(usage, ["cache_read_input_tokens", "cached_tokens", "cachedContentTokenCount"]);
  const cacheCreation = tokenCount(usage, ["cache_creation_input_tokens"]);
  if (input === undefined && output === undefined && total === undefined && cachedInput === undefined && cacheCreation === undefined) return;
  const fields = [
    input === undefined ? "" : `input=${input}`,
    output === undefined ? "" : `output=${output}`,
    total === undefined ? "" : `total=${total}`,
    cachedInput === undefined ? "" : `cachedInput=${cachedInput}`,
    cacheCreation === undefined ? "" : `cacheCreation=${cacheCreation}`,
  ].filter(Boolean).join(" ");
  toolHooks.debugLog(context, `TOKENS provider=${provider} round=${round} ${fields}`);
}
