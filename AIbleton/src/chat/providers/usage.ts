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
  const inputDetails = usage.input_tokens_details;
  const outputDetails = usage.output_tokens_details;
  const cachedInput = tokenCount(usage, ["cache_read_input_tokens", "cached_tokens", "cachedContentTokenCount"])
    ?? (inputDetails && typeof inputDetails === "object" ? tokenCount(inputDetails as ProviderTokenUsage, ["cached_tokens"]) : undefined);
  const reasoning = outputDetails && typeof outputDetails === "object"
    ? tokenCount(outputDetails as ProviderTokenUsage, ["reasoning_tokens"]) : undefined;
  const cacheCreation = tokenCount(usage, ["cache_creation_input_tokens"]);
  if (input === undefined && output === undefined && total === undefined && cachedInput === undefined && cacheCreation === undefined && reasoning === undefined) return;
  const fields = [
    input === undefined ? "" : `input=${input}`,
    output === undefined ? "" : `output=${output}`,
    total === undefined ? "" : `total=${total}`,
    cachedInput === undefined ? "" : `cachedInput=${cachedInput}`,
    cacheCreation === undefined ? "" : `cacheCreation=${cacheCreation}`,
    reasoning === undefined ? "" : `reasoning=${reasoning}`,
  ].filter(Boolean).join(" ");
  toolHooks.debugLog(context, `TOKENS provider=${provider} round=${round} ${fields}`);
}
