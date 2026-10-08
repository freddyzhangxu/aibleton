import type { RecipeParameterTarget } from "./recipes.js";

export type RuntimeParameter = {
  name: string;
  min: number;
  max: number;
  isQuantized?: boolean;
  valueItems?: readonly { name: string }[];
};

export type MatchedRecipeTarget<T extends RuntimeParameter> = {
  target: RecipeParameterTarget;
  parameter: T;
  value: number;
};

export type SkippedRecipeTarget = {
  target: RecipeParameterTarget;
  reason: "missing" | "ambiguous" | "unsupported" | "invalid-range";
};

export type RecipeTargetMatch<T extends RuntimeParameter> = {
  matched: MatchedRecipeTarget<T>[];
  skipped: SkippedRecipeTarget[];
};

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function parameterMatches<T extends RuntimeParameter>(
  parameters: readonly T[],
  aliases: readonly string[],
): T[] {
  const exact = new Set<T>();
  for (const alias of aliases) {
    const normalizedAlias = normalizeName(alias);
    if (!normalizedAlias) continue;
    for (const parameter of parameters) {
      if (normalizeName(parameter.name) === normalizedAlias) exact.add(parameter);
    }
  }
  return [...exact];
}

function optionIndex(options: readonly { name: string }[], aliases: readonly string[]): number {
  const exact = new Set<number>();
  for (const alias of aliases) {
    const normalizedAlias = normalizeName(alias);
    options.forEach((option, index) => {
      if (normalizeName(option.name) === normalizedAlias) exact.add(index);
    });
  }
  if (exact.size === 1) return [...exact][0];
  return exact.size > 1 ? -2 : -1;
}

export function matchRecipeTargets<T extends RuntimeParameter>(
  parameters: readonly T[],
  targets: readonly RecipeParameterTarget[],
): RecipeTargetMatch<T> {
  const matched: MatchedRecipeTarget<T>[] = [];
  const skipped: SkippedRecipeTarget[] = [];

  for (const target of targets) {
    const candidates = parameterMatches(parameters, target.aliases);
    if (!candidates.length) {
      skipped.push({ target, reason: "missing" });
      continue;
    }
    if (candidates.length !== 1) {
      skipped.push({ target, reason: "ambiguous" });
      continue;
    }

    const parameter = candidates[0];
    if (target.kind === "enum") {
      if (!parameter.isQuantized || !parameter.valueItems?.length) {
        skipped.push({ target, reason: "unsupported" });
        continue;
      }
      const index = optionIndex(parameter.valueItems, target.optionAliases);
      if (index === -2) {
        skipped.push({ target, reason: "ambiguous" });
        continue;
      }
      if (index < 0) {
        skipped.push({ target, reason: "missing" });
        continue;
      }
      matched.push({ target, parameter, value: index });
      continue;
    }

    const min = Number(parameter.min);
    const max = Number(parameter.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min ||
        !Number.isFinite(target.normalizedValue) || target.normalizedValue < 0 || target.normalizedValue > 1) {
      skipped.push({ target, reason: "invalid-range" });
      continue;
    }
    const value = Math.min(max, Math.max(min, min + target.normalizedValue * (max - min)));
    matched.push({ target, parameter, value });
  }

  return { matched, skipped };
}
