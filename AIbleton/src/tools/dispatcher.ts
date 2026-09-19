import * as path from "node:path";
import {
  AudioTrack,
  Device,
  DrumChain,
  DrumRack,
  MidiClip,
  MidiTrack,
  Simpler,
} from "@ableton-extensions/sdk";
import {
  AUDIO_PROVIDER_NAMES,
  audioProviderEnv,
  generateAudio,
  generatedAudioDir,
} from "../audiogen.js";
import {
  kitRoots,
  mkdirOutsideSandbox,
  pathExists,
  readdirNames,
  writeHomeBinary,
} from "../paths.js";
import { recordGeneration } from "../genlog/index.js";
import {
  MoveError,
  downloadSet,
  listFiles,
  listSets,
  moveHost,
  pairComplete,
  pairStart,
  systemVersion,
  uploadFile,
} from "../move.js";
import { moveExtras, moveSongToSnapshot, parseMoveBundle } from "../movebundle.js";
import { searchSampleIndex } from "../samplemeta.js";
import { webFetch, webSearch } from "../websearch.js";
import {
  analyzeMusicState,
  analyzeSong,
  presentAnalysis,
  selectMusicContext,
} from "../analysis/index.js";
import { enrichMusicStateWithAudio } from "../audiofiles.js";
import { buildMusicState } from "../musicstate/builder.js";
import { toolHooks, toolState, type Ctx } from "../state.js";
import {
  applySwing,
  buildSongSnapshot,
  deviceAt,
  deviceRefFrom,
  gridLabel,
  midiTrackAt,
  paramAt,
  parseNotes,
  resolveTrack,
  setParamValue,
  snapNotesToGrid,
  toBpm,
  toNum,
  toStrArr,
  trackResult,
} from "./helpers.js";
import { arrangeSong } from "./arrange.js";
import { analyzeRenderedTrack } from "./rendered.js";
import { deleteAuthorizationError, deleteToolIsAuthorized, isDeleteTool } from "../chat/deleteauth.js";

// ---------- Factory drum kits (Drum Essentials pack) ----------

type KitPad = { note: number; name: string; file: string };

/** GM-style note map so models can reuse standard drum programming knowledge. */
const KIT_808: KitPad[] = [
  { note: 36, name: "Kick", file: "Kick/Kick 808 Long.aif" },
  { note: 37, name: "Rim", file: "Rim/Rim-808.aif" },
  { note: 38, name: "Snare", file: "Snare/Snare 808 Dry.aif" },
  { note: 39, name: "Clap", file: "Clap/Clap-808.aif" },
  { note: 41, name: "Tom Low", file: "Tom/Tom-808-Low.aif" },
  { note: 42, name: "Hihat Closed", file: "Hihat/Hihat Closed 808.aif" },
  { note: 43, name: "Tom Mid", file: "Tom/Tom-808-Mid.aif" },
  { note: 45, name: "Tom Hi", file: "Tom/Tom 808 Hi I.aif" },
  { note: 46, name: "Hihat Open", file: "Hihat/Hihat Open 808 1 Onyx.aif" },
  { note: 49, name: "Cymbal", file: "Cymbal/Cymbal 808 VA90.aif" },
  { note: 75, name: "Clave", file: "Wood/Clave-808.aif" },
];

const KIT_909: KitPad[] = [
  { note: 36, name: "Kick", file: "Kick/Kick-909.aif" },
  { note: 37, name: "Rim", file: "Rim/Rim-909.aif" },
  { note: 38, name: "Snare", file: "Snare/Snare-909-Tune8.aif" },
  { note: 39, name: "Clap", file: "Clap/Clap-909.aif" },
  { note: 41, name: "Tom Low", file: "Tom/Tom-909-Low.aif" },
  { note: 42, name: "Hihat Closed", file: "Hihat/Hihat-909-Closed.aif" },
  { note: 43, name: "Tom Mid", file: "Tom/Tom-909-Mid.aif" },
  { note: 45, name: "Tom Hi", file: "Tom/Tom-909-Hi.aif" },
  { note: 46, name: "Hihat Open", file: "Hihat/Hihat-909-Open.aif" },
  { note: 49, name: "Cymbal", file: "Cymbal/Crash-909.aif" },
  { note: 51, name: "Ride", file: "Ride/Ride-909.aif" },
];

const NAMED_KITS: Record<string, KitPad[]> = { "808": KIT_808, "909": KIT_909 };

/** Slots for building a kit for any other style keyword by scanning the pack. */
const KIT_SLOTS: { note: number; name: string; folder: string; hint?: RegExp }[] = [
  { note: 36, name: "Kick", folder: "Kick" },
  { note: 37, name: "Rim", folder: "Rim" },
  { note: 38, name: "Snare", folder: "Snare" },
  { note: 39, name: "Clap", folder: "Clap" },
  { note: 41, name: "Tom Low", folder: "Tom", hint: /low/i },
  { note: 42, name: "Hihat Closed", folder: "Hihat", hint: /clos/i },
  { note: 43, name: "Tom Mid", folder: "Tom", hint: /mid/i },
  { note: 45, name: "Tom Hi", folder: "Tom", hint: /hi/i },
  { note: 46, name: "Hihat Open", folder: "Hihat", hint: /open/i },
  { note: 49, name: "Cymbal", folder: "Cymbal" },
  { note: 51, name: "Ride", folder: "Ride" },
];

const AUDIO_EXT = /\.(aif|aiff|wav)$/i;

/** Resolve a style keyword ("909", "tr-707", "dmx", …) to a pad list under `root`. */
function resolveKit(root: string, style: string): KitPad[] {
  const key = style.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return KIT_808;
  for (const [name, kit] of Object.entries(NAMED_KITS)) {
    if (key === name || key.endsWith(name)) return kit;
  }
  // "tr606"/"roland808" → also try the bare model number/word as keyword.
  const bare = key.replace(/^[a-z]+/, "");
  const keys = bare ? [key, bare] : [key];
  const used = new Set<string>();
  const pads: KitPad[] = [];
  for (const slot of KIT_SLOTS) {
    const dir = path.join(root, slot.folder);
    const candidates = (readdirNames(dir) ?? []).filter((f) => {
      if (!AUDIO_EXT.test(f) || used.has(f)) return false;
      const norm = f.toLowerCase().replace(/[^a-z0-9]/g, "");
      return keys.some((k) => norm.includes(k));
    });
    if (!candidates.length) continue;
    const pick =
      (slot.hint ? candidates.find((f) => slot.hint!.test(f)) : undefined) ?? candidates.sort()[0];
    used.add(pick);
    pads.push({ note: slot.note, name: slot.name, file: path.join(slot.folder, pick) });
  }
  if (!pads.some((p) => p.note === 36) || pads.length < 4) {
    throw new Error(
      `Drum Essentials 里找不到风格「${style}」的成套鼓采样（匹配到 ${pads.length} 个 pad，至少需要 kick + 3 件）。` +
        "已知风格：808 / 909 / 707 / 606 / DMX；其它采样请用 search_samples + load_sample。",
    );
  }
  return pads;
}
/** Resolve a fuzzy param ref + raw value (numeric or enum name) and set it. */
async function applyDeviceParam(
  device: Device<"1.0.0">,
  rawParam: string,
  rawValue: string,
): Promise<{ parameter: string; value: string | number }> {
  const param = paramAt(device, /^-?\d+$/.test(rawParam) ? Number(rawParam) : rawParam);
  let value: number;
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
    value = Number(rawValue);
  } else {
    const q = rawValue.toLowerCase();
    const items = param.valueItems;
    let found = items.findIndex((v) => v.name.toLowerCase() === q);
    if (found < 0) found = items.findIndex((v) => v.name.toLowerCase().includes(q));
    if (found < 0) {
      throw new Error(
        `参数「${param.name}」不接受文本值「${rawValue}」` +
          (items.length ? `。可选：${items.map((v) => v.name).join(", ")}` : "（该参数为数值型）"),
      );
    }
    value = found;
  }
  value = await setParamValue(param, value);
  const display =
    param.isQuantized && param.valueItems[value] ? param.valueItems[value].name : value;
  return { parameter: param.name, value: display };
}

function requireMovePaired(): void {
  if (!toolState.moveSettings.token) {
    throw new Error("Move 尚未配对 — 先调用 move_pair（不带 code）获取屏幕上的配对码。");
  }
}

export async function runTool(
  context: Ctx,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const song = context.application.song;
  // runTool is also used by tests and could gain non-agent callers later.
  // Keep the destructive SDK boundary protected even if runtime is bypassed.
  if (isDeleteTool(name) && !deleteToolIsAuthorized(name, toolState.activeDeleteAuthorization)) {
    return deleteAuthorizationError(name);
  }

  switch (name) {
    case "get_song_overview": {
      return {
        tempo: song.tempo,
        scale: song.scaleMode ? song.scaleName : "(scale mode off)",
        tracks: song.tracks.map((t, i) => ({
          index: i,
          name: t.name,
          type: t instanceof MidiTrack ? "MIDI" : "Audio",
          mute: t.mute,
          solo: t.solo,
          arm: t.arm,
          arrangementClips: t.arrangementClips.length,
          devices: t.devices.map((d) => d.name),
        })),
        returnTracks: song.returnTracks.map((t) => t.name),
        scenes: song.scenes.map((s, i) => ({ index: i, name: s.name })),
      };
    }
    case "analyze_song": {
      // Three-stage: facts (what is in the Set) -> interpretation (what it
      // means) -> presentation (model-bound JSON, budget-fitted). Optional
      // focus runs the Context Selector between interpretation and
      // presentation (select.ts) for a focused projection. audio:true inserts
      // async source-file enrichment between facts and interpretation
      // (audiofiles.ts) — buildMusicState itself stays sync and pure.
      const state = buildMusicState(buildSongSnapshot(song));
      const audioRun =
        input.audio === true ? await enrichMusicStateWithAudio(state) : undefined;
      const ma = analyzeMusicState(state);
      const focus =
        typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : undefined;
      return presentAnalysis(
        state,
        ma,
        5800,
        focus ? selectMusicContext(state, ma, focus) : undefined,
        audioRun,
      );
    }
    case "analyze_rendered_track": {
      return analyzeRenderedTrack(context, input);
    }
    case "set_goal": {
      return toolHooks.handleSetGoal(context, input);
    }
    case "set_plan": {
      return toolHooks.handleSetPlan(context, input);
    }
    case "arrange_song": {
      return arrangeSong(context, input);
    }
    case "update_memory": {
      // Partial update: only fields present in input are touched; "" / [] / 0
      // clear a field. Writes memory.json next to providers.json.
      const p = toolState.artistMemory;
      if (typeof input.name === "string") p.name = input.name.trim() || undefined;
      if (input.genres !== undefined) p.genres = toStrArr(input.genres);
      if (input.keys !== undefined) p.keys = toStrArr(input.keys);
      if (input.sound !== undefined) p.sound = toStrArr(input.sound);
      if (input.artists !== undefined) p.artists = toStrArr(input.artists);
      if (typeof input.notes === "string") p.notes = input.notes.trim() || undefined;
      if (input.bpmMin !== undefined) {
        const v = toBpm(input.bpmMin);
        if (Number(input.bpmMin) !== 0 && v === undefined) throw new Error("bpmMin 需在 20–999 之间（0 表示清除）");
        p.bpmMin = v;
      }
      if (input.bpmMax !== undefined) {
        const v = toBpm(input.bpmMax);
        if (Number(input.bpmMax) !== 0 && v === undefined) throw new Error("bpmMax 需在 20–999 之间（0 表示清除）");
        p.bpmMax = v;
      }
      if (p.bpmMin && p.bpmMax && p.bpmMin > p.bpmMax) {
        [p.bpmMin, p.bpmMax] = [p.bpmMax, p.bpmMin];
      }
      toolState.artistMemory = p;
      toolHooks.saveArtistMemory();
      // Return the merged memory so the model sees (and can quote) the result.
      return { saved: true, memory: toolState.artistMemory };
    }
    case "set_tempo": {
      const bpm = Number(input.bpm);
      if (!(bpm >= 20 && bpm <= 999)) throw new Error("BPM 需在 20–999 之间");
      song.tempo = bpm;
      return { tempo: song.tempo };
    }
    case "create_midi_track": {
      const track = await context.withinTransaction(() => song.createMidiTrack());
      if (input.name) track.name = String(input.name);
      return { created: track.name, type: "MIDI" };
    }
    case "create_audio_track": {
      const track = await context.withinTransaction(() => song.createAudioTrack());
      if (input.name) track.name = String(input.name);
      return { created: track.name, type: "Audio" };
    }
    case "duplicate_track": {
      const ref = resolveTrack(context, input, "track_index");
      const track = await context.withinTransaction(() => song.duplicateTrack(ref.track));
      return { duplicated: ref.track.name, created: track.name, track_index: song.tracks.indexOf(track) };
    }
    case "delete_track": {
      const ref = resolveTrack(context, input, "track_index");
      const deleted = { name: ref.track.name, track_index: ref.index };
      await context.withinTransaction(() => song.deleteTrack(ref.track));
      return {
        deleted: "track",
        ...deleted,
        undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。",
      };
    }
    case "create_move_track": {
      const channel = Math.min(16, Math.max(1, Math.round(Number(input.channel) || 1)));
      const track = await context.withinTransaction(() => song.createMidiTrack());
      track.name = String(input.name || `Move Ch ${channel}`);
      return {
        created: track.name,
        type: "MIDI",
        routing_setup_required:
          `One-time manual routing (the SDK cannot set this): 1) In Live, set this track's Output Type to "Ableton Move" and Output Channel to ${channel}. ` +
          `2) On Move: firmware ≥1.5, Standalone Mode (NOT Control Live), USB-C to this computer; hold Shift + press a track button and set that track's MIDI In to channel ${channel} (or Auto). ` +
          `Notes, velocity and poly aftertouch reach Move; MIDI CC does not. From then on, any clip you write into this track plays on Move.`,
      };
    }
    case "move_status": {
      try {
        const version = await systemVersion(toolState.moveSettings);
        return { connected: true, paired: true, host: moveHost(toolState.moveSettings), firmware: version };
      } catch (e) {
        if (e instanceof MoveError && e.status === 401) {
          return {
            connected: true,
            paired: false,
            host: moveHost(toolState.moveSettings),
            hint: "设备可达，但尚未配对 — 调用 move_pair（不带 code）让 Move 显示配对码。",
          };
        }
        throw e;
      }
    }
    case "move_pair": {
      const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : undefined;
      if (host) toolState.moveSettings.host = host;
      const code = typeof input.code === "string" ? input.code.trim() : "";
      if (!code) {
        await pairStart(toolState.moveSettings);
        return {
          pairing: "code_shown",
          message:
            "Move 屏幕上现在显示一个 6 位配对码。请让用户报出这串数字，然后用 move_pair({ code }) 完成配对。",
        };
      }
      toolState.moveSettings.token = await pairComplete(toolState.moveSettings, code);
      toolHooks.saveManualConfigs();
      return { paired: true, host: moveHost(toolState.moveSettings) };
    }
    case "move_list_sets": {
      requireMovePaired();
      return { sets: await listSets(toolState.moveSettings) };
    }
    case "move_list_files": {
      requireMovePaired();
      const dir = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
      return { path: dir ?? "/", entries: await listFiles(toolState.moveSettings, dir) };
    }
    case "move_upload_sample": {
      requireMovePaired();
      const filePath = String(input.file_path || "");
      if (!filePath) throw new Error("file_path 不能为空");
      const folder =
        typeof input.folder === "string" && input.folder.trim() ? input.folder.trim() : "Samples";
      const result = await uploadFile(toolState.moveSettings, filePath, folder, input.overwrite === true);
      return {
        ...result,
        message: `${result.uploaded} 已上传到 Move 的 ${result.folder} 文件夹（${Math.round(result.size / 1024)} KB）— 在 Move 上即可找到，可装入鼓垫或旋律轨道。`,
      };
    }
    case "move_download_set": {
      requireMovePaired();
      const setId = String(input.set_id || "");
      if (!setId) throw new Error("set_id 不能为空");
      const { filename, data } = await downloadSet(toolState.moveSettings, setId);
      const dir = generatedAudioDir();
      mkdirOutsideSandbox(dir);
      const target = path.join(dir, filename);
      writeHomeBinary(target, data);
      return {
        saved: target,
        size: data.length,
        message: `Set 已下载到 ${target}（${Math.round(data.length / 1024)} KB）。`,
      };
    }
    case "move_analyze_set": {
      requireMovePaired();
      const setId = String(input.set_id || "");
      if (!setId) throw new Error("set_id 不能为空");
      const setName = (await listSets(toolState.moveSettings)).find((s) => s.id === setId)?.name ?? "";
      const { filename, data } = await downloadSet(toolState.moveSettings, setId);
      // Parse from memory first — a corrupt bundle shouldn't leave a file behind.
      const bundle = parseMoveBundle(data);
      const dir = generatedAudioDir();
      mkdirOutsideSandbox(dir);
      const target = path.join(dir, filename);
      writeHomeBinary(target, data);
      const result = {
        set: setName || filename.replace(/\.ablbundle$/i, ""),
        saved: target,
        ...analyzeSong(
          moveSongToSnapshot(bundle.song),
          5800,
          typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : undefined,
        ),
        move: moveExtras(bundle) as unknown as Record<string, unknown>,
      };
      // analyzeSong fits itself to 5800 — the move extras ride on top of that,
      // so trim them in stages to stay under callTool's 6000-char hard cut.
      const size = () => JSON.stringify(result).length;
      const m = result.move as unknown as {
        samples?: unknown[];
        samplesOmitted?: number;
        tracks?: { files?: unknown; devices?: unknown }[];
      };
      if (size() > 5800 && Array.isArray(m.samples) && m.samples.length > 10) {
        m.samplesOmitted = m.samples.length - 10;
        m.samples = m.samples.slice(0, 10);
      }
      if (size() > 5800) for (const t of m.tracks ?? []) delete t.files;
      if (size() > 5800) for (const t of m.tracks ?? []) delete t.devices;
      return result;
    }
    case "rename_track": {
      const ref = resolveTrack(context, input, "index");
      const oldName = ref.track.name;
      ref.track.name = String(input.name);
      return trackResult(ref, { renamed: oldName, to: ref.track.name });
    }
    case "set_track_state": {
      const ref = resolveTrack(context, input, "index");
      const track = ref.track;
      if (typeof input.mute === "boolean") track.mute = input.mute;
      if (typeof input.solo === "boolean") track.solo = input.solo;
      if (typeof input.arm === "boolean") track.arm = input.arm;
      return trackResult(ref, { track: track.name, mute: track.mute, solo: track.solo, arm: track.arm });
    }
    case "insert_device": {
      const ref = resolveTrack(context, input, "index");
      const track = ref.track;
      const device = await context.withinTransaction(() =>
        track.insertDevice(String(input.device_name), track.devices.length),
      );
      return trackResult(ref, { inserted: device.name, into: track.name });
    }
    case "delete_device": {
      const ref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, ref.index, deviceRefFrom(input));
      const deviceIndex = ref.track.devices.indexOf(device);
      const name = device.name;
      await context.withinTransaction(() => ref.track.deleteDevice(device));
      return trackResult(ref, {
        deleted: "device",
        device: name,
        device_index: deviceIndex,
        undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。",
      });
    }
    case "create_scene": {
      const index = typeof input.index === "number" ? input.index : -1;
      const scene = await context.withinTransaction(() => song.createScene(index));
      if (input.name) scene.name = String(input.name);
      return { created: scene.name };
    }
    case "duplicate_scene": {
      const index = Number(input.index);
      const scene = song.scenes[index];
      if (!Number.isInteger(index) || !scene) throw new Error("场景索引无效");
      const copy = await context.withinTransaction(() => song.duplicateScene(scene));
      return { duplicated: scene.name, created: copy.name, index: song.scenes.indexOf(copy) };
    }
    case "delete_scene": {
      const index = Number(input.scene_index);
      const scene = song.scenes[index];
      if (!Number.isInteger(index) || !scene) throw new Error("场景索引无效");
      const name = scene.name;
      await context.withinTransaction(() => song.deleteScene(scene));
      return {
        deleted: "scene",
        name,
        scene_index: index,
        undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。",
      };
    }
    case "create_cue_point": {
      const bar = Number(input.bar);
      if (!Number.isInteger(bar) || bar < 1) throw new Error("bar 必须是从 1 开始的整数");
      const s0 = song.scenes[0];
      const beats = (toNum(s0?.signatureNumerator) || 4) * 4 / (toNum(s0?.signatureDenominator) || 4);
      const cue = await context.withinTransaction(() => song.createCuePoint((bar - 1) * beats));
      cue.name = String(input.name ?? "").trim();
      return { created: cue.name, bar };
    }
    case "rename_cue_point": {
      const index = Number(input.index);
      const cue = song.cuePoints[index];
      if (!Number.isInteger(index) || !cue) throw new Error("Cue Point 索引无效");
      const oldName = cue.name;
      cue.name = String(input.name ?? "").trim();
      return { renamed: oldName, to: cue.name, index };
    }
    case "delete_cue_point": {
      const index = Number(input.index);
      const cue = song.cuePoints[index];
      if (!Number.isInteger(index) || !cue) throw new Error("Cue Point 索引无效");
      const name = cue.name;
      await context.withinTransaction(() => song.deleteCuePoint(cue));
      return { deleted: name, index };
    }
    case "get_device_parameters": {
      const tref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, tref.index, deviceRefFrom(input));
      const filter = typeof input.filter === "string" ? input.filter.toLowerCase() : "";
      const all = await Promise.all(
        device.parameters.map(async (p, i) => {
          if (filter && !p.name.toLowerCase().includes(filter)) return null;
          const value = await p.getValue();
          return {
            index: i,
            name: p.name,
            value,
            min: p.min,
            max: p.max,
            ...(p.isQuantized && p.valueItems.length
              ? { items: p.valueItems.map((v) => v.name) }
              : {}),
          };
        }),
      );
      let params = all.filter((p) => p !== null);
      // Keep tool results small: huge payloads get rejected by some API gateways.
      const cap = filter ? 120 : 40;
      let truncated = false;
      if (params.length > cap) {
        params = params.slice(0, cap);
        truncated = true;
      }
      return trackResult(tref, {
        device: device.name,
        parameterCount: device.parameters.length,
        ...(truncated
          ? { note: `仅返回前 ${cap} 个参数。请用 filter 按名称精确查询（如 "freq"、"reso"、"coarse"、"lfo"）` }
          : {}),
        parameters: params,
      });
    }
    case "set_device_parameter": {
      const tref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, tref.index, deviceRefFrom(input));
      const applied = await applyDeviceParam(
        device,
        String(input.parameter ?? "").trim(),
        String(input.value ?? "").trim(),
      );
      return trackResult(tref, { device: device.name, ...applied });
    }
    case "set_device_parameters": {
      const tref = resolveTrack(context, input, "track_index");
      const device = deviceAt(context, tref.index, deviceRefFrom(input));
      const items = (Array.isArray(input.params) ? input.params : []).slice(0, 24);
      if (!items.length) throw new Error("params 不能为空（[{parameter, value}, …]）");
      // Independent sets — run them in parallel; per-item failures don't abort the rest.
      const results = await Promise.all(
        items.map(async (it) => {
          const rawParam = String((it as Record<string, unknown>)?.parameter ?? "").trim();
          const rawValue = String((it as Record<string, unknown>)?.value ?? "").trim();
          try {
            return { ok: true as const, ...(await applyDeviceParam(device, rawParam, rawValue)) };
          } catch (e) {
            return { ok: false as const, parameter: rawParam || "?", error: (e as Error).message };
          }
        }),
      );
      const applied = results.filter((r) => r.ok).map(({ ok: _, ...rest }) => rest);
      const failed = results.filter((r) => !r.ok).map(({ ok: _, ...rest }) => rest);
      return trackResult(tref, {
        device: device.name,
        applied,
        ...(failed.length ? { failed } : {}),
      });
    }
    case "set_track_mixer": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const out: Record<string, unknown> = { track: track.name };
      if (typeof input.volume !== "undefined") {
        out.volume = await setParamValue(track.mixer.volume, Number(input.volume));
      }
      if (typeof input.pan !== "undefined") {
        out.pan = await setParamValue(track.mixer.panning, Number(input.pan));
      }
      if (input.sends !== undefined) {
        if (!Array.isArray(input.sends) || input.sends.length > 12) throw new Error("sends 必须是最多 12 项的数组");
        const returns = song.returnTracks;
        out.sends = await Promise.all(input.sends.map(async (raw) => {
          const spec = raw as Record<string, unknown>;
          const index = Number(spec.index);
          if (!Number.isInteger(index) || index < 0 || index >= track.mixer.sends.length) {
            throw new Error(`Send 索引 ${String(spec.index)} 无效；该轨道共有 ${track.mixer.sends.length} 个 Send（0 起计）`);
          }
          return { index, return_track: returns[index]?.name ?? `Send ${index}`, value: await setParamValue(track.mixer.sends[index], Number(spec.value)) };
        }));
      }
      return trackResult(ref, out);
    }
    case "get_track_mixer": {
      const ref = resolveTrack(context, input, "track_index");
      const returns = song.returnTracks;
      const [volume, pan, ...sendValues] = await Promise.all([
        ref.track.mixer.volume.getValue(),
        ref.track.mixer.panning.getValue(),
        ...ref.track.mixer.sends.slice(0, 12).map((send) => send.getValue()),
      ]);
      return trackResult(ref, {
        track: ref.track.name,
        volume,
        pan,
        sends: sendValues.map((value, index) => ({ index, return_track: returns[index]?.name ?? `Send ${index}`, value })),
      });
    }
    case "load_drum_kit": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const style = String(input.kit ?? "").trim();
      const roots = kitRoots();
      const root = roots.find((r) => pathExists(r));
      if (!root) {
        throw new Error("找不到 Drum Essentials 音色包（已检查: " + roots.join(" | ") + "）");
      }
      const kit = resolveKit(root, style);
      const missing = kit.filter((p) => !pathExists(path.join(root, p.file)));
      if (missing.length) {
        throw new Error(
          "缺少采样文件: " + missing.map((m) => m.file).join(", ") +
            " — Drum Essentials 包不完整；改用 search_samples 找替代采样，再用 load_sample 手动加载",
        );
      }

      const build = () => {
        const rackReady = (async () => {
          let rack = track.devices.find(
            (d): d is DrumRack<"1.0.0"> => d instanceof DrumRack && d.chains.length === 0,
          );
          if (!rack) {
            rack = (await track.insertDevice("Drum Rack", 0)) as DrumRack<"1.0.0">;
          }
          return rack;
        })();
        // Pads are independent — build them in parallel (one round of RPCs per
        // stage instead of 33 sequential awaits). Each chain inserts at index 0;
        // pad order in the rack is not meaningful (receivingNote decides routing).
        return rackReady.then((rack) =>
          Promise.all(
            kit.map(async (pad) => {
              const chain = (await rack.insertChain(0)) as DrumChain<"1.0.0">;
              chain.receivingNote = pad.note;
              const simpler = (await chain.insertDevice("Simpler", 0)) as Simpler<"1.0.0">;
              await simpler.replaceSample(path.join(root, pad.file));
              return `${pad.note}=${pad.name}`;
            }),
          ),
        );
      };
      const pads = await context.withinTransaction(build);
      return trackResult(ref, { track: track.name, kit: style || "808", pads });
    }
    case "search_samples": {
      const q = String(input.query ?? "").trim();
      if (!q) throw new Error("query 不能为空");
      return searchSampleIndex(toolHooks.buildSampleIndex(), q, 30);
    }
    case "web_search": {
      // Should be unreachable (the tools list already hides it when off) —
      // this is the safety net, e.g. a stale request mid-toggle.
      if (!toolState.webSettings.enabled) {
        throw new Error("联网搜索已关闭：设置(齿轮) → 联网搜索 打开后可用 / Web search is off — enable it in Settings → Web Search");
      }
      const results = await webSearch(String(input.query ?? ""), toolState.abortCtl?.signal ?? undefined, toolState.activeLanguage);
      return { total: results.length, results };
    }
    case "web_fetch": {
      if (!toolState.webSettings.enabled) {
        throw new Error("联网搜索已关闭：设置(齿轮) → 联网搜索 打开后可用 / Web search is off — enable it in Settings → Web Search");
      }
      return await webFetch(String(input.url ?? ""), toolState.abortCtl?.signal ?? undefined, toolState.activeLanguage);
    }
    case "import_audio_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      if (!(track instanceof AudioTrack)) {
        throw new Error(`轨道 ${ref.index}（${track.name}）不是音频轨道，先用 create_audio_track 建一条`);
      }
      const filePath = String(input.file_path ?? "");
      if (!pathExists(filePath)) {
        throw new Error(`找不到文件: ${filePath} — 用 search_samples 按关键词搜索可用样本，或检查路径拼写`);
      }
      if (typeof input.scene_index === "number") {
        const sceneIndex = Number(input.scene_index);
        const slot = track.clipSlots[sceneIndex];
        if (!Number.isInteger(sceneIndex) || !slot) throw new Error(`场景序号 ${sceneIndex} 无效`);
        if (slot.clip) throw new Error("该 clip 槽已有 clip，请先删除或换一个槽位");
        const managed = await context.resources.importIntoProject(filePath);
        const clip = await context.withinTransaction(() =>
          slot.createAudioClip({
            filePath: managed,
            ...(typeof input.warped === "boolean" ? { isWarped: input.warped } : {}),
          }),
        );
        return trackResult(ref, { clip: clip.name, scene_index: sceneIndex, file: managed });
      }
      const managed = await context.resources.importIntoProject(filePath);
      const clip = await context.withinTransaction(() =>
        track.createAudioClip({
          filePath: managed,
          startTime: Number(input.start_beat ?? 0),
          ...(typeof input.duration_beats === "number" ? { duration: input.duration_beats } : {}),
          ...(typeof input.warped === "boolean" ? { isWarped: input.warped } : {}),
        }),
      );
      return trackResult(ref, { clip: clip.name, file: managed });
    }
    case "load_sample": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const filePath = String(input.file_path ?? "");
      if (!pathExists(filePath)) {
        throw new Error(`找不到文件: ${filePath} — 用 search_samples 按关键词搜索可用样本，或检查路径拼写`);
      }
      const managed = await context.resources.importIntoProject(filePath);
      let simpler = track.devices.find((d): d is Simpler<"1.0.0"> => d instanceof Simpler);
      if (!simpler) {
        simpler = (await context.withinTransaction(() =>
          track.insertDevice("Simpler", 0),
        )) as Simpler<"1.0.0">;
      }
      await simpler.replaceSample(managed);
      return trackResult(ref, { track: track.name, device: "Simpler", file: managed });
    }
    case "generate_audio": {
      const cfg = toolState.activeAudioConfig;
      if (!cfg) {
        throw new Error(
          `未配置音频生成 API Key:设置(齿轮)→ 音频生成 里填所选提供商的 key,或设环境变量 ${audioProviderEnv("stable-audio")} / ${audioProviderEnv("elevenlabs")} / ${audioProviderEnv("minimax")}`,
        );
      }
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const duration = Math.min(190, Math.max(1, Number(input.duration_seconds ?? 8) || 8));
      const file = await generateAudio(
        cfg,
        {
          prompt,
          seconds: duration,
          instrumental: typeof input.instrumental === "boolean" ? input.instrumental : undefined,
          lyrics: typeof input.lyrics === "string" ? input.lyrics : undefined,
          language: toolState.activeLanguage,
        },
        toolState.abortCtl?.signal ?? undefined,
      );
      // Let search_samples find the new file without a restart.
      toolHooks.invalidateSampleIndex();
      // Registry bookkeeping (PR17): decodes features for later refine diffs.
      // Never let it fail the generation itself.
      let generationId: string | undefined;
      try {
        generationId = recordGeneration({
          file,
          provider: cfg.provider,
          prompt,
          params: {
            seconds: duration,
            ...(typeof input.instrumental === "boolean" ? { instrumental: input.instrumental } : {}),
            ...(typeof input.lyrics === "string" ? { lyrics: input.lyrics } : {}),
          },
        }).id;
      } catch {
        generationId = undefined;
      }
      // Atomic generate→import (PR18): same internal path as import_audio_clip.
      // A failed import never fails the generation — the file is already saved
      // and recorded, the error rides the result as import_error.
      let imported: Record<string, unknown> | undefined;
      let importError: string | undefined;
      if (input.importTo && typeof input.importTo === "object") {
        const spec = input.importTo as Record<string, unknown>;
        try {
          const ref = resolveTrack(context, spec, "track_index");
          const track = ref.track;
          if (!(track instanceof AudioTrack)) {
            throw new Error(`轨道 ${ref.index}（${track.name}）不是音频轨道，先用 create_audio_track 建一条`);
          }
          const managed = await context.resources.importIntoProject(file);
          if (typeof spec.scene_index === "number") {
            const sceneIndex = Number(spec.scene_index);
            const slot = track.clipSlots[sceneIndex];
            if (!Number.isInteger(sceneIndex) || !slot) throw new Error(`场景序号 ${sceneIndex} 无效`);
            if (slot.clip) throw new Error("该 clip 槽已有 clip，请先删除或换一个槽位");
            const clip = await context.withinTransaction(() =>
              slot.createAudioClip({
                filePath: managed,
                ...(typeof spec.warped === "boolean" ? { isWarped: spec.warped } : {}),
              }),
            );
            imported = { track: track.name, track_index: ref.index, scene_index: sceneIndex, clip: clip.name };
          } else {
            const clip = await context.withinTransaction(() =>
              track.createAudioClip({
                filePath: managed,
                startTime: Number(spec.start_beat ?? 0),
                ...(typeof spec.duration_beats === "number" ? { duration: spec.duration_beats } : {}),
                ...(typeof spec.warped === "boolean" ? { isWarped: spec.warped } : {}),
              }),
            );
            imported = { track: track.name, track_index: ref.index, clip: clip.name };
          }
        } catch (e) {
          importError = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        file,
        provider: AUDIO_PROVIDER_NAMES[cfg.provider],
        duration_seconds: duration,
        ...(generationId ? { generation_id: generationId } : {}),
        ...(imported ? { imported } : {}),
        ...(importError ? { import_error: importError } : {}),
        ...(imported
          ? {}
          : {
              next: importError
                ? `导入失败(${importError}) — 文件已保存,可改用 import_audio_clip 重试或检查轨道类型`
                : "用 import_audio_clip 放上编排(loop/stem)或 load_sample 装进 Simpler(one-shot),或下次直接传 importTo",
            }),
      };
    }
    case "write_midi_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = midiTrackAt(context, ref.index);
      const start = Number(input.start_beat ?? 0);
      const length = Number(input.length_beats ?? 16);
      if (!(length > 0)) throw new Error("length_beats 必须大于 0");
      const clip = await context.withinTransaction(() => track.createMidiClip(start, length));
      // Snap before swing so baked swing offsets survive; grid read live from the song.
      const gridQ = toNum(song.gridQuantization);
      const gridT = Boolean(song.gridIsTriplet);
      const snap = input.snap_to_grid !== false;
      let notes = parseNotes(input.notes, length);
      if (snap) notes = snapNotesToGrid(notes, gridQ, gridT);
      notes = applySwing(notes, Number(input.swing ?? 0)).filter((n) => n.startTime < length);
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return trackResult(ref, {
        clip: clip.name,
        start,
        length,
        noteCount: notes.length,
        swing: Number(input.swing ?? 0),
        ...(snap ? { snapped_to_grid: gridLabel(gridQ, gridT) } : {}),
      });
    }
    case "write_session_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const track = midiTrackAt(context, ref.index);
      const sceneIndex = Number(input.scene_index);
      const slot = track.clipSlots[sceneIndex];
      if (!slot) throw new Error(`场景序号 ${sceneIndex} 无效`);
      if (slot.clip) throw new Error("该 clip 槽已有 clip，请先删除或换一个槽位");
      const length = Number(input.length_beats ?? 16);
      const clip = await context.withinTransaction(() => slot.createMidiClip(length));
      const gridQ = toNum(song.gridQuantization);
      const gridT = Boolean(song.gridIsTriplet);
      const snap = input.snap_to_grid !== false;
      let notes = parseNotes(input.notes, length);
      if (snap) notes = snapNotesToGrid(notes, gridQ, gridT);
      notes = applySwing(notes, Number(input.swing ?? 0)).filter((n) => n.startTime < length);
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return trackResult(ref, {
        clip: clip.name,
        length,
        noteCount: notes.length,
        swing: Number(input.swing ?? 0),
        ...(snap ? { snapped_to_grid: gridLabel(gridQ, gridT) } : {}),
      });
    }
    case "delete_arrangement_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const clipIndex = Number(input.clip_index);
      const clip = ref.track.arrangementClips[clipIndex];
      if (!Number.isInteger(clipIndex) || !clip) throw new Error("编排区 Clip 索引无效");
      const name = clip.name;
      await context.withinTransaction(() => ref.track.deleteClip(clip));
      return trackResult(ref, {
        deleted: "arrangement_clip",
        clip: name,
        clip_index: clipIndex,
        undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。",
      });
    }
    case "delete_session_clip": {
      const ref = resolveTrack(context, input, "track_index");
      const sceneIndex = Number(input.scene_index);
      const slot = ref.track.clipSlots[sceneIndex];
      if (!Number.isInteger(sceneIndex) || !slot) throw new Error("Session 场景索引无效");
      if (!slot.clip) throw new Error("该 Session Clip 槽为空，未执行删除");
      const name = slot.clip.name;
      await context.withinTransaction(() => slot.deleteClip());
      return trackResult(ref, {
        deleted: "session_clip",
        clip: name,
        scene_index: sceneIndex,
        undo: "已删除；如需恢复，请在 Live 中执行 Undo（⌘Z / Ctrl+Z）。",
      });
    }
    case "get_clip_notes": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      return trackResult(ref, {
        name: clip.name,
        start: clip.startTime,
        duration: clip.duration,
        notes: clip.notes.map((n) => ({
          pitch: n.pitch,
          start: n.startTime,
          duration: n.duration,
          velocity: n.velocity,
        })),
      });
    }
    case "set_clip_notes": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const clip = track.arrangementClips[Number(input.clip_index)];
      if (!clip) throw new Error("clip 序号无效");
      if (!(clip instanceof MidiClip)) throw new Error("该 clip 不是 MIDI clip");
      const gridQ = toNum(song.gridQuantization);
      const gridT = Boolean(song.gridIsTriplet);
      const snap = input.snap_to_grid !== false;
      let notes = parseNotes(input.notes, clip.duration);
      if (snap) notes = snapNotesToGrid(notes, gridQ, gridT);
      clip.notes = notes;
      return trackResult(ref, {
        clip: clip.name,
        noteCount: notes.length,
        start: Number(clip.startTime),
        length: Number(clip.duration),
        ...(snap ? { snapped_to_grid: gridLabel(gridQ, gridT) } : {}),
      });
    }
    case "rename_scene": {
      const scenes = song.scenes;
      const i = Number(input.index);
      if (!Number.isInteger(i) || i < 0 || i >= scenes.length) {
        throw new Error(`场景序号 ${i} 无效`);
      }
      const oldName = scenes[i].name;
      scenes[i].name = String(input.name);
      return { renamed: oldName, to: scenes[i].name };
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}
