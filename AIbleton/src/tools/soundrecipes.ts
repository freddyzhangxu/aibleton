import { basename } from "node:path";
import { MidiTrack, Simpler, type Device } from "@ableton-extensions/sdk";
import { searchSampleIndex } from "../samplemeta.js";
import { soundRecipeIsAuthorized, soundRecipeSourceChangeAuthorized } from "../chat/deleteauth.js";
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

function sourceChangeIsAuthorized(context: Ctx, ref: TrackRef, recipeId: SoundRecipeId): boolean {
  if (!soundRecipeSourceChangeAuthorized(toolState.activeDeleteAuthorization, toolState.activeYolo, recipeId)) return false;
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

const LEGACY_UNSUITABLE_SAMPLE = /(?:^|[^a-z0-9])(?:kick|snare|clap|hi[ -]?hat|hihat|cymbal|tom|rim|drum|percussion|perc|loop|fill)(?:$|[^a-z0-9])/i;
const DRUM_OR_FILL_SAMPLE = /(?:^|[^a-z0-9])(?:kick|snare|clap|hi[ -]?hat|hihat|cymbal|tom|rim|drum|percussion|perc|fill)(?:$|[^a-z0-9])/i;
const LOOP_SAMPLE_MARKER = /(?:^|[^a-z0-9])(?:loop|looped|looping)(?:$|[^a-z0-9])/i;
const ONE_SHOT_UNSUITABLE_MARKER = /(?:^|[^a-z0-9])(?:loop|looped|looping|phrase)(?:$|[^a-z0-9])/i;

function isSuitableSample(recipe: SoundRecipe, filePath: string): boolean {
  const fileName = basename(filePath).replace(/\.[^.]+$/, "").normalize("NFKC").toLocaleLowerCase();
  if (recipe.samplePlayback === undefined) {
    if (LEGACY_UNSUITABLE_SAMPLE.test(fileName)) return false;
  } else {
    if (DRUM_OR_FILL_SAMPLE.test(fileName)) return false;
    if (recipe.samplePlayback === "loop" && !LOOP_SAMPLE_MARKER.test(fileName)) return false;
    if (recipe.samplePlayback === "one_shot" && ONE_SHOT_UNSUITABLE_MARKER.test(fileName)) return false;
  }
  const compact = fileName.replace(/[^a-z0-9]/g, "");
  if (recipe.role === "bass") {
    const hasBassEvidence = compact.includes("bass") || compact.includes("sub") || compact.includes("808");
    if (!hasBassEvidence) return false;
    if (recipe.id === "hiphop_808_bass") return compact.includes("808") || compact.includes("sub");
    return compact.includes("bass");
  }
  const hasEvidence = (term: string): boolean =>
    compact.includes(term.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLocaleLowerCase());
  if (recipe.sampleEvidenceGroups?.length) {
    return recipe.sampleEvidenceGroups.every((group) => group.some(hasEvidence));
  }
  const evidence = recipe.sampleEvidence ?? [];
  return evidence.some(hasEvidence);
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
  forceReplace = false,
): Promise<{ device?: Device<"1.0.0">; replaced?: string; failure?: Record<string, unknown> }> {
  const currentName = current?.device.name;
  const currentId = current ? handleIdOf(current.device) : undefined;
  if (!forceReplace && current && currentName?.toLocaleLowerCase() === deviceName.toLocaleLowerCase()) {
    return { device: current.device };
  }
  if (current && !allowSourceChange) {
    return {
      failure: trackResult(ref, {
        executed: false,
        requires_source_authorization: true,
        current_source: currentName,
        requested_source: deviceName,
        message: "需要用户明确要求将该轨应用此音色方案，才能更换主音源。",
      }),
    };
  }

  const insertAt = current?.index ?? 0;
  if (current) {
    try {
      await context.withinTransaction(() => ref.track.deleteDevice(current.device));
    } catch (error) {
      const sourceStillPresent = ref.track.devices.some((device) =>
        currentId !== undefined ? handleIdOf(device) === currentId : device === current.device,
      );
      const sourceDeleted = !sourceStillPresent;
      return {
        failure: trackResult(ref, {
          executed: sourceDeleted,
          replacement_not_applied: true,
          source_deleted: sourceDeleted,
          ...(currentName ? { source: currentName } : {}),
          replacement: deviceName,
          reason: error instanceof Error ? error.message : String(error),
          ...(sourceDeleted ? { undo: "原音源已删除；请在 Live 中使用 Undo（⌘Z / Ctrl+Z）恢复。" } : {}),
        }),
      };
    }
    forgetCreatedDevice(current.device);
  }
  try {
    const device = await context.withinTransaction(() => ref.track.insertDevice(deviceName, insertAt));
    recordCreatedDevice(device);
    return { device, ...(currentName ? { replaced: currentName } : {}) };
  } catch (error) {
    return {
      failure: trackResult(ref, {
        executed: !!current,
        replacement_not_applied: true,
        source_deleted: !!current,
        ...(currentName ? { source: currentName } : {}),
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

async function cleanupStagedSampleDevice(
  context: Ctx,
  ref: TrackRef,
  device: Device<"1.0.0">,
): Promise<string | undefined> {
  try {
    await context.withinTransaction(() => ref.track.deleteDevice(device));
    forgetCreatedDevice(device);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function stagedSampleFailure(
  ref: TrackRef,
  recipe: SoundRecipe,
  stagedName: string,
  reason: string,
  cleanupError?: string,
  replaced?: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const currentPrimary = findPrimarySource(ref.track as MidiTrack<"1.0.0">);
  const currentSource = currentPrimary === "ambiguous" ? "ambiguous" : currentPrimary?.device.name ?? "none";
  return trackResult(ref, {
    recipe: recipe.id,
    role: recipe.role,
    executed: !!cleanupError || !!replaced,
    replacement_not_applied: true,
    sample_setup_failed: true,
    ...(cleanupError ? { partial_change: true, cleanup_error: cleanupError } : {}),
    ...(replaced ? { source_deleted: true, replaced_source: replaced } : {}),
    current_source: currentSource,
    requested_source: stagedName,
    staged_device: stagedName,
    playback_mode: recipe.samplePlayback,
    reason,
    current_devices: ref.track.devices.map((device) => device.name),
    ...extra,
    ...(replaced
      ? { undo: `原音源「${replaced}」已删除，采样配方设置失败；请在 Live 中使用 Undo（⌘Z / Ctrl+Z）恢复。` }
      : cleanupError
        ? { undo: "新插入的 Simpler 未能清理；请在 Live 中使用 Undo（⌘Z / Ctrl+Z）恢复。" }
        : {}),
  });
}

async function applyDeleteFirstSampleRecipe(
  context: Ctx,
  ref: TrackRef,
  current: PrimarySource,
  recipe: SoundRecipe,
  selectedSample: string,
): Promise<Record<string, unknown>> {
  let importedSample: string;
  try {
    importedSample = await context.resources.importIntoProject(selectedSample);
  } catch (error) {
    return trackResult(ref, {
      recipe: recipe.id,
      role: recipe.role,
      executed: false,
      sample_import_failed: true,
      file: selectedSample,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const ensured = await ensurePrimaryDevice(context, ref, current, "Simpler", true, true);
  if (ensured.failure) return ensured.failure;
  const staged = ensured.device as Simpler<"1.0.0">;
  const replaced = ensured.replaced;
  const stagedName = staged.name;

  const targets = recipe.targets.Simpler ?? [];
  const match = matchRecipeTargets(staged.parameters, targets);
  const requiredPlaybackIds = recipe.samplePlayback === "loop" ? ["playback_mode", "loop"] : [];
  const skippedIds = new Set(match.skipped.map(({ target }) => target.id));
  const missingRequired = requiredPlaybackIds.filter((id) => skippedIds.has(id));
  if (missingRequired.length) {
    const cleanupError = await cleanupStagedSampleDevice(context, ref, staged);
    return stagedSampleFailure(
      ref,
      recipe,
      stagedName,
      "Simpler 缺少唯一可用的循环控制：" + missingRequired.join(", "),
      cleanupError,
      replaced,
      {
        skipped: match.skipped.map(({ target, reason }) => ({ target: target.id, reason })),
      },
    );
  }

  const applied: { target: string; parameter: string; value: string | number }[] = [];
  const playbackTargets = match.matched
    .filter(({ target }) => requiredPlaybackIds.includes(target.id))
    .sort((a, b) => requiredPlaybackIds.indexOf(a.target.id) - requiredPlaybackIds.indexOf(b.target.id));
  for (const item of playbackTargets) {
    try {
      const value = await setParamValue(item.parameter, item.value);
      applied.push({
        target: item.target.id,
        parameter: item.parameter.name,
        value: formattedValue(staged, item.parameter.name, value),
      });
    } catch (error) {
      const cleanupError = await cleanupStagedSampleDevice(context, ref, staged);
      return stagedSampleFailure(
        ref,
        recipe,
        stagedName,
        error instanceof Error ? error.message : String(error),
        cleanupError,
        replaced,
        { target: item.target.id, parameter: item.parameter.name },
      );
    }
  }

  try {
    await context.withinTransaction(() => staged.replaceSample(importedSample));
  } catch (error) {
    const cleanupError = await cleanupStagedSampleDevice(context, ref, staged);
    return stagedSampleFailure(
      ref,
      recipe,
      stagedName,
      error instanceof Error ? error.message : String(error),
      cleanupError,
      replaced,
      { file: importedSample },
    );
  }

  const failed: { target: string; parameter: string; error: string }[] = [];
  for (const item of match.matched) {
    if (requiredPlaybackIds.includes(item.target.id)) continue;
    try {
      const value = await setParamValue(item.parameter, item.value);
      applied.push({
        target: item.target.id,
        parameter: item.parameter.name,
        value: formattedValue(staged, item.parameter.name, value),
      });
    } catch (error) {
      failed.push({
        target: item.target.id,
        parameter: item.parameter.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed.length) {
    const cleanupError = await cleanupStagedSampleDevice(context, ref, staged);
    return stagedSampleFailure(
      ref,
      recipe,
      stagedName,
      "无法应用一个或多个匹配的 Simpler 包络参数。",
      cleanupError,
      replaced,
      { file: importedSample, failed },
    );
  }

  return trackResult(ref, {
    recipe: recipe.id,
    role: recipe.role,
    track: ref.track.name,
    source: {
      kind: "sample",
      device: stagedName,
      file: importedSample,
      playback_mode: recipe.samplePlayback,
      ...(replaced ? { replaced } : {}),
    },
    applied,
    skipped: match.skipped.map(({ target, reason }) => ({ target: target.id, reason })),
  });
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
  if (!soundRecipeIsAuthorized(toolState.activeDeleteAuthorization, recipe.id, toolState.activeYolo)) {
    return trackResult(ref, {
      executed: false,
      requires_source_authorization: true,
      requested_recipe: recipe.id,
      allowed_recipes: [...(toolState.activeDeleteAuthorization?.allowedSoundRecipeIds ?? [])],
      message: "当前请求只授权了指定的非采样 Keys 配方；没有执行其他音色方案。",
    });
  }
  if (recipe.role === "pluck" && recipe.source === "contextual") {
    throw new Error(`Pluck recipe ${recipe.id} must choose a specific synth or sample source`);
  }
  if (recipe.role === "pluck" && recipe.source === "sample" && !recipe.sampleEvidence?.length && !recipe.sampleEvidenceGroups?.length) {
    throw new Error(`Pluck sample recipe ${recipe.id} needs filename evidence terms`);
  }
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
  let sampleSearchFailure: string | undefined;
  let fallback = false;
  if (sourceKind === "sample") {
    try {
      selectedSample = findSample(recipe);
    } catch (error) {
      sampleSearchFailure = error instanceof Error ? error.message : String(error);
    }
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
  const needsSourceChange = sampleChange || deviceChange ||
    (sourceKind === "sample" && !!recipe.samplePlayback && !!current);
  const authorized = !needsSourceChange || sourceChangeIsAuthorized(context, ref, recipe.id);
  if (!authorized) {
    return trackResult(ref, {
      executed: false,
      requires_source_authorization: true,
      current_source: current?.device.name ?? "none",
      requested_source: requestedDevice,
      message: "请明确要求将这条轨道应用该风格方案后再更换主音源。",
    });
  }

  if (sourceKind === "sample" && selectedSample && recipe.samplePlayback) {
    return applyDeleteFirstSampleRecipe(context, ref, current, recipe, selectedSample);
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
    role: recipe.role,
    track: ref.track.name,
    source: {
      kind: sourceKind,
      device: device.name,
      ...(importedSample ? { file: importedSample } : {}),
      ...(fallback ? {
        fallback: true,
        note: sampleSearchFailure
          ? `本地采样搜索失败，已改用合成器近似：${sampleSearchFailure}`
          : "本地没有匹配采样，已改用合成器近似。",
      } : {}),
      ...(ensured.replaced ? { replaced: ensured.replaced } : {}),
    },
    applied,
    skipped: match.skipped.map(({ target, reason }) => ({ target: target.id, reason })),
    ...(failed.length ? { failed } : {}),
  });
}
