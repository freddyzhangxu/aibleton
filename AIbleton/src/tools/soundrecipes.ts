import { basename } from "node:path";
import { MidiTrack, Simpler, type Device } from "@ableton-extensions/sdk";
import { searchSampleIndex } from "../samplemeta.js";
import { soundRecipeSourceChangeAuthorized } from "../chat/deleteauth.js";
import { SOUND_RECIPES, type SoundRecipeId, type SoundRecipe } from "../sound/recipes.js";
import { matchRecipeTargets } from "../sound/parameter-targets.js";
import { toolHooks, toolState, type Ctx } from "../state.js";
import { resolvedSelection } from "../setcontext.js";
import { resolveTrack, setParamValue, trackResult } from "./helpers.js";
import { forgetCreatedDevice, handleIdOf, recordCreatedDevice } from "./created-devices.js";

const INSTRUMENT_NAMES = new Set([
  "analog", "collision", "drift", "electric", "impulse", "meld", "operator", "sampler",
  "simpler", "tension", "wavetable",
]);

const EFFECT_NAMES = new Set([
  "amp", "auto filter", "auto pan", "cabinet", "chorus-ensemble", "compressor", "delay",
  "drum buss", "echo", "eq eight", "frequency shifter", "gate", "glue compressor",
  "hybrid reverb", "multiband dynamics", "pedal", "phaser-flanger", "reverb", "redux",
  "roar", "saturator", "simple delay", "utility",
]);

type TrackRef = ReturnType<typeof resolveTrack>;
type PrimarySource = { device: Device<"1.0.0">; index: number } | null;

function findPrimarySource(track: MidiTrack<"1.0.0">): PrimarySource | "ambiguous" {
  const instruments: { device: Device<"1.0.0">; index: number }[] = [];
  const unknown: string[] = [];
  for (const [index, device] of track.devices.entries()) {
    const name = device.name.trim().toLocaleLowerCase();
    if (INSTRUMENT_NAMES.has(name)) instruments.push({ device, index });
    else if (!EFFECT_NAMES.has(name)) unknown.push(device.name);
  }
  if (unknown.length || instruments.length > 1) return "ambiguous";
  return instruments[0] ?? null;
}

function selectedTrackIndices(context: Ctx): number[] {
  const selection = resolvedSelection(context);
  if (!selection) return [];
  return selection.kind === "arrangement"
    ? selection.tracks.map((track) => track.index)
    : [...new Set(selection.slots.map((slot) => slot.trackIndex))];
}

function trackIsInCurrentScope(context: Ctx, ref: TrackRef): boolean {
  if (toolState.activeGlobalIntent) return true;
  const explicit = toolState.activeExplicitEditScope.trackIndices;
  const selected = selectedTrackIndices(context);
  const inExplicitScope = !explicit.length || explicit.includes(ref.index);
  const inSelection = !selected.length || selected.includes(ref.index);
  if (inExplicitScope && inSelection && (explicit.length > 0 || selected.length > 0)) return true;
  const id = handleIdOf(ref.track);
  return id !== undefined && toolState.activeCreatedTrackHandles.has(id);
}

function sourceChangeIsAuthorized(context: Ctx, ref: TrackRef): boolean {
  if (!soundRecipeSourceChangeAuthorized(toolState.activeDeleteAuthorization, toolState.activeYolo)) return false;
  return trackIsInCurrentScope(context, ref);
}

function recipeFor(id: unknown): SoundRecipe {
  if (typeof id !== "string" || !Object.hasOwn(SOUND_RECIPES, id)) {
    throw new Error(`未知音色方案；可用方案：${Object.keys(SOUND_RECIPES).join(", ")}`);
  }
  return SOUND_RECIPES[id as SoundRecipeId];
}

function contextualSource(
  recipe: SoundRecipe,
  current: PrimarySource,
  preferred?: "sample" | "synth",
): "sample" | "synth" {
  if (recipe.source !== "contextual") return recipe.source;
  if (preferred) return preferred;
  return current?.device instanceof Simpler ? "sample" : "synth";
}

function isSuitableSample(recipe: SoundRecipe, filePath: string): boolean {
  const fileName = basename(filePath).replace(/\.[^.]+$/, "").normalize("NFKC").toLocaleLowerCase();
  if (/(?:^|[^a-z0-9])(?:kick|snare|clap|hi[ -]?hat|hihat|cymbal|tom|rim|drum|percussion|perc|loop|fill)(?:$|[^a-z0-9])/i.test(fileName)) {
    return false;
  }
  const compact = fileName.replace(/[^a-z0-9]/g, "");
  const hasBassEvidence = compact.includes("bass") || compact.includes("sub") || compact.includes("808");
  if (!hasBassEvidence) return false;
  if (recipe.id === "hiphop_808_bass") return compact.includes("808") || compact.includes("sub");
  return compact.includes("bass");
}

function findSample(recipe: SoundRecipe): string | undefined {
  const index = toolHooks.buildSampleIndex();
  for (const query of recipe.sampleQueries) {
    const result = searchSampleIndex(index, query, 30, toolState.activeLanguage);
    const suitable = result.results.find((filePath) => isSuitableSample(recipe, filePath));
    if (suitable) return suitable;
  }
  return undefined;
}

async function ensurePrimaryDevice(
  context: Ctx,
  ref: TrackRef,
  current: PrimarySource,
  deviceName: string,
  allowSourceChange: boolean,
): Promise<{ device?: Device<"1.0.0">; replaced?: string; failure?: Record<string, unknown> }> {
  if (current?.device.name.toLocaleLowerCase() === deviceName.toLocaleLowerCase()) {
    return { device: current.device };
  }
  if (current && !allowSourceChange) {
    return {
      failure: trackResult(ref, {
        executed: false,
        requires_source_authorization: true,
        current_source: current.device.name,
        requested_source: deviceName,
        message: "需要用户明确要求将该 Bass 轨应用此音色方案，才能更换主音源。",
      }),
    };
  }

  const insertAt = current?.index ?? 0;
  if (current) {
    await context.withinTransaction(() => ref.track.deleteDevice(current.device));
    forgetCreatedDevice(current.device);
  }
  try {
    const device = await context.withinTransaction(() => ref.track.insertDevice(deviceName, insertAt));
    recordCreatedDevice(device);
    return { device, ...(current ? { replaced: current.device.name } : {}) };
  } catch (error) {
    return {
      failure: trackResult(ref, {
        executed: false,
        replacement_not_applied: true,
        source_deleted: !!current,
        ...(current ? { source: current.device.name } : {}),
        replacement: deviceName,
        reason: error instanceof Error ? error.message : String(error),
        ...(current ? { undo: "原音源已删除但替换失败；请在 Live 中使用 Undo（⌘Z / Ctrl+Z）恢复。" } : {}),
      }),
    };
  }
}

function formattedValue(device: Device<"1.0.0">, targetId: string, value: number): string | number {
  const target = device.parameters.find((param) => param.name === targetId);
  if (target?.isQuantized && target.valueItems[value]) return target.valueItems[value].name;
  return value;
}

export async function applySoundRecipe(
  context: Ctx,
  input: {
    track_index: number;
    track_name: string;
    recipe_id: SoundRecipeId;
    source_preference?: "sample" | "synth";
  },
): Promise<Record<string, unknown>> {
  const ref = resolveTrack(context, input, "track_index");
  if (!trackIsInCurrentScope(context, ref)) {
    return trackResult(ref, {
      executed: false,
      selection_scope_refused: true,
      message: "目标轨道不在当前请求或 Live 选择范围内；没有改动工程。",
    });
  }
  if (!(ref.track instanceof MidiTrack)) {
    return trackResult(ref, { executed: false, error: "音色方案目前只能应用到 MIDI 轨道。" });
  }
  const recipe = recipeFor(input.recipe_id);
  const current = findPrimarySource(ref.track);
  if (current === "ambiguous") {
    return trackResult(ref, {
      executed: false,
      source_ambiguous: true,
      devices: ref.track.devices.map((device) => device.name),
      message: "无法唯一识别这条轨道的主音源；没有改动工程。",
    });
  }

  let sourceKind = contextualSource(recipe, current, input.source_preference);
  let selectedSample: string | undefined;
  let fallback = false;
  if (sourceKind === "sample") {
    selectedSample = findSample(recipe);
    if (!selectedSample) {
      sourceKind = "synth";
      fallback = true;
    }
  }
  const requestedDevice = sourceKind === "sample" ? "Simpler" : recipe.instrument ?? recipe.fallbackInstrument;
  const currentSample = current?.device instanceof Simpler ? current.device.sample?.filePath : undefined;
  const sampleChange = sourceKind === "sample" && !!current &&
    (!(current.device instanceof Simpler) || !!currentSample);
  const deviceChange = !!current && current.device.name.toLocaleLowerCase() !== requestedDevice.toLocaleLowerCase();
  const needsSourceChange = sampleChange || deviceChange;
  const authorized = !needsSourceChange || sourceChangeIsAuthorized(context, ref);
  if (!authorized) {
    return trackResult(ref, {
      executed: false,
      requires_source_authorization: true,
      current_source: current?.device.name ?? "none",
      requested_source: requestedDevice,
      message: "请明确要求将这条 Bass 轨应用该风格方案后再更换主音源。",
    });
  }

  let importedSample: string | undefined;
  if (sourceKind === "sample" && selectedSample) {
    try {
      importedSample = await context.resources.importIntoProject(selectedSample);
    } catch (error) {
      return trackResult(ref, {
        executed: false,
        sample_import_failed: true,
        file: selectedSample,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ensured = await ensurePrimaryDevice(context, ref, current, requestedDevice, authorized);
  if (ensured.failure) return ensured.failure;
  const device = ensured.device!;
  if (sourceKind === "sample" && selectedSample) {
    const simpler = device as Simpler<"1.0.0">;
    try {
      await context.withinTransaction(() => simpler.replaceSample(importedSample!));
    } catch (error) {
      return trackResult(ref, {
        recipe: recipe.id,
        executed: true,
        replacement_not_applied: true,
        source: { kind: sourceKind, device: device.name, file: importedSample, ...(ensured.replaced ? { replaced: ensured.replaced } : {}) },
        failed: [{ target: "sample", parameter: "Simpler sample", error: error instanceof Error ? error.message : String(error) }],
        ...(ensured.replaced ? { undo: "原音源已删除但采样未能加载；请在 Live 中使用 Undo（⌘Z / Ctrl+Z）恢复。" } : {}),
      });
    }
  }

  const targets = recipe.targets[device.name] ?? [];
  const match = matchRecipeTargets(device.parameters, targets);
  const applied: { target: string; parameter: string; value: string | number }[] = [];
  const failed: { target: string; parameter: string; error: string }[] = [];
  for (const item of match.matched) {
    try {
      const value = await setParamValue(item.parameter, item.value);
      applied.push({
        target: item.target.id,
        parameter: item.parameter.name,
        value: formattedValue(device, item.parameter.name, value),
      });
    } catch (error) {
      failed.push({
        target: item.target.id,
        parameter: item.parameter.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return trackResult(ref, {
    recipe: recipe.id,
    track: ref.track.name,
    source: {
      kind: sourceKind,
      device: device.name,
      ...(importedSample ? { file: importedSample } : {}),
      ...(fallback ? { fallback: true, note: "本地没有匹配采样，已改用合成器近似。" } : {}),
      ...(ensured.replaced ? { replaced: ensured.replaced } : {}),
    },
    applied,
    skipped: match.skipped.map(({ target, reason }) => ({ target: target.id, reason })),
    ...(failed.length ? { failed } : {}),
  });
}
