import type { PlanStep } from "./types.js";

/** The JSON Schema subset used by AIbleton's local tool definitions. */
export interface InputSchema {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, InputSchema>;
  items?: InputSchema;
  additionalProperties?: boolean;
}

export type ExecutionPreflight = { ok: true } | { ok: false; errors: string[] };

export interface PlanStepOutcome {
  ok: boolean;
  result: unknown;
  error?: string;
}

export interface PlanExecutionReport {
  completedStepIds: string[];
  failedStepId?: string;
  failure?: string;
  skippedStepIds: string[];
  stopped: boolean;
}

const MAX_STEPS = 12;
const MAX_TOTAL_ARGS_CHARS = 96_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReference(value: unknown): value is { $ref: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$ref === "string";
}

interface ParsedReference {
  stepId: string;
  segments: string[];
}

function parseReference(value: string): ParsedReference | null {
  const marker = value.indexOf("#/");
  if (marker <= 0) return null;
  const stepId = value.slice(0, marker);
  const encoded = value.slice(marker + 2);
  const segments: string[] = [];
  for (const segment of encoded.split("/")) {
    if (/~(?![01])/.test(segment)) return null;
    segments.push(segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return { stepId, segments };
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function schemaTypes(schema: InputSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : [];
}

function validateValue(value: unknown, schema: InputSchema, path: string, errors: string[]): void {
  const types = schemaTypes(schema);
  if (types.length && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path} must be ${types.join(" or ")}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} is not an allowed value`);
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        validateValue(child, childSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  } else if (Array.isArray(value) && schema.items) {
    value.forEach((child, index) => validateValue(child, schema.items!, `${path}[${index}]`, errors));
  }
}

function validateTemplate(
  value: unknown,
  schema: InputSchema | undefined,
  stepIndex: number,
  stepIndices: ReadonlyMap<string, number>,
  path: string,
  errors: string[],
): void {
  if (isReference(value)) {
    const ref = parseReference(value.$ref);
    if (!ref) {
      errors.push(`${path} has a malformed $ref`);
      return;
    }
    const sourceIndex = stepIndices.get(ref.stepId);
    if (sourceIndex === undefined) errors.push(`${path} references missing step "${ref.stepId}"`);
    else if (sourceIndex >= stepIndex) errors.push(`${path} must reference an earlier step`);
    if (!schema) errors.push(`${path} is not a typed tool input location`);
    return;
  }
  if (schema) {
    const types = schemaTypes(schema);
    if (types.length && !types.some((type) => typeMatches(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`);
      return;
    }
    if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
      errors.push(`${path} is not an allowed value`);
    }
  }
  if (isRecord(value)) {
    for (const key of schema?.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema?.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        validateTemplate(child, childSchema, stepIndex, stepIndices, `${path}.${key}`, errors);
      } else if (schema?.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (isReference(child)) {
        validateTemplate(child, undefined, stepIndex, stepIndices, `${path}.${key}`, errors);
      }
    }
  } else if (Array.isArray(value) && schema?.items) {
    value.forEach((child, index) =>
      validateTemplate(child, schema.items, stepIndex, stepIndices, `${path}[${index}]`, errors),
    );
  } else if (schema) {
    validateValue(value, schema, path, errors);
  }
}

/** Validate an executable plan completely before any Set-changing tool runs. */
export function preflightExecutablePlan(
  steps: readonly PlanStep[],
  schemas: ReadonlyMap<string, InputSchema>,
  allowedTools: ReadonlySet<string>,
): ExecutionPreflight {
  const errors: string[] = [];
  if (!steps.length) errors.push("plan has no steps");
  if (steps.length > MAX_STEPS) errors.push(`plan exceeds ${MAX_STEPS} steps`);

  let totalArgsChars = 0;
  for (const step of steps) {
    if (step.args === undefined) continue;
    try {
      totalArgsChars += JSON.stringify(step.args).length;
    } catch {
      errors.push(`step "${step.id}" args are not JSON serializable`);
    }
  }
  if (totalArgsChars > MAX_TOTAL_ARGS_CHARS) errors.push(`plan args exceed ${MAX_TOTAL_ARGS_CHARS} characters`);

  const stepIndices = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!step.id.trim()) errors.push(`step ${index + 1} has an empty ID`);
    else if (stepIndices.has(step.id)) errors.push(`duplicate step ID "${step.id}"`);
    else stepIndices.set(step.id, index);
  });

  steps.forEach((step, index) => {
    if (!step.tool) errors.push(`step "${step.id}" has no tool`);
    else if (!allowedTools.has(step.tool)) errors.push(`step "${step.id}" uses unsupported tool "${step.tool}"`);
    const schema = step.tool ? schemas.get(step.tool) : undefined;
    if (step.tool && !schema) errors.push(`step "${step.id}" has no local input schema`);
    if (!isRecord(step.args)) {
      errors.push(`step "${step.id}" args must be an object`);
      return;
    }
    if (schema) {
      validateTemplate(step.args, schema, index, stepIndices, `step "${step.id}" args`, errors);
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true };
}

function resolvePointer(source: unknown, segments: readonly string[]): { ok: true; value: unknown } | { ok: false; error: string } {
  let value = source;
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { ok: false, error: `invalid array index "${segment}"` };
      const index = Number(segment);
      if (index >= value.length || !Object.hasOwn(value, index)) return { ok: false, error: `missing array index "${segment}"` };
      value = value[index];
    } else if (isRecord(value) && Object.hasOwn(value, segment)) {
      value = value[segment];
    } else {
      return { ok: false, error: `missing result path segment "${segment}"` };
    }
  }
  return { ok: true, value };
}

/** Resolve an argument template using successful earlier step results only. */
export function resolvePlanReferences(
  value: unknown,
  inputSchema: InputSchema,
  earlierResults: ReadonlyMap<string, unknown>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const resolve = (current: unknown, schema: InputSchema | undefined, path: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (isReference(current)) {
      const ref = parseReference(current.$ref);
      if (!ref) return { ok: false, error: `${path} has a malformed $ref` };
      if (!schema) return { ok: false, error: `${path} is not a typed tool input location` };
      if (!earlierResults.has(ref.stepId)) return { ok: false, error: `step "${ref.stepId}" has no successful result` };
      const found = resolvePointer(earlierResults.get(ref.stepId), ref.segments);
      if (!found.ok) return found;
      const typeErrors: string[] = [];
      validateValue(found.value, schema, path, typeErrors);
      if (typeErrors.length) return { ok: false, error: typeErrors.join("; ") };
      return found;
    }
    if (Array.isArray(current)) {
      const out: unknown[] = [];
      for (const [index, child] of current.entries()) {
        const resolved = resolve(child, schema?.items, `${path}[${index}]`);
        if (!resolved.ok) return resolved;
        out.push(resolved.value);
      }
      return { ok: true, value: out };
    }
    if (isRecord(current)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(current)) {
        const resolved = resolve(child, schema?.properties?.[key], `${path}.${key}`);
        if (!resolved.ok) return resolved;
        Object.defineProperty(out, key, { value: resolved.value, enumerable: true, configurable: true, writable: true });
      }
      return { ok: true, value: out };
    }
    if (schema) {
      const errors: string[] = [];
      validateValue(current, schema, path, errors);
      if (errors.length) return { ok: false, error: errors.join("; ") };
    }
    return { ok: true, value: current };
  };
  return resolve(value, inputSchema, "args");
}

/** Sequential, fail-fast plan runner. Side effects are owned by `runStep`. */
export async function executePlanSequentially(
  steps: readonly PlanStep[],
  schemas: ReadonlyMap<string, InputSchema>,
  runStep: (step: PlanStep, resolvedArgs: Record<string, unknown>) => Promise<PlanStepOutcome>,
  shouldStop: () => boolean,
): Promise<PlanExecutionReport> {
  const completedStepIds: string[] = [];
  const results = new Map<string, unknown>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (shouldStop()) {
      return {
        completedStepIds,
        skippedStepIds: steps.slice(index).map((remaining) => remaining.id),
        stopped: true,
      };
    }
    const schema = step.tool ? schemas.get(step.tool) : undefined;
    const resolved = schema && isRecord(step.args)
      ? resolvePlanReferences(step.args, schema, results)
      : { ok: false as const, error: `step "${step.id}" has no valid tool arguments` };
    if (!resolved.ok) {
      return {
        completedStepIds,
        failedStepId: step.id,
        failure: resolved.error,
        skippedStepIds: steps.slice(index + 1).map((remaining) => remaining.id),
        stopped: false,
      };
    }
    let outcome: PlanStepOutcome;
    try {
      outcome = await runStep(step, resolved.value as Record<string, unknown>);
    } catch (error) {
      return {
        completedStepIds,
        failedStepId: step.id,
        failure: error instanceof Error ? error.message : String(error),
        skippedStepIds: steps.slice(index + 1).map((remaining) => remaining.id),
        stopped: false,
      };
    }
    if (!outcome.ok) {
      return {
        completedStepIds,
        failedStepId: step.id,
        failure: outcome.error ?? "tool step failed",
        skippedStepIds: steps.slice(index + 1).map((remaining) => remaining.id),
        stopped: false,
      };
    }
    completedStepIds.push(step.id);
    results.set(step.id, outcome.result);
  }
  return { completedStepIds, skippedStepIds: [], stopped: false };
}
