import * as path from "node:path";
import {
  AudioTrack,
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
  midiTrackAt,
  paramAt,
  parseNotes,
  resolveTrack,
  setParamValue,
  toBpm,
  toStrArr,
  trackResult,
} from "./helpers.js";
import { arrangeSong } from "./arrange.js";

// ---------- Factory 808 drum kit (Drum Essentials pack) ----------

/** GM-style note map so models can reuse standard drum programming knowledge. */
const KIT_808 = [
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
    case "create_scene": {
      const index = typeof input.index === "number" ? input.index : -1;
      const scene = await context.withinTransaction(() => song.createScene(index));
      if (input.name) scene.name = String(input.name);
      return { created: scene.name };
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
      const rawParam = String(input.parameter ?? "").trim();
      const param = paramAt(device, /^-?\d+$/.test(rawParam) ? Number(rawParam) : rawParam);

      const rawValue = String(input.value ?? "").trim();
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
        param.isQuantized && param.valueItems[value]
          ? param.valueItems[value].name
          : value;
      return trackResult(tref, { device: device.name, parameter: param.name, value: display, range: [param.min, param.max] });
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
      return trackResult(ref, out);
    }
    case "load_drum_kit": {
      const ref = resolveTrack(context, input, "track_index");
      const track = ref.track;
      const roots = kitRoots();
      const root = roots.find((r) => pathExists(r));
      if (!root) {
        throw new Error("找不到 Drum Essentials 音色包（已检查: " + roots.join(" | ") + "）");
      }
      const missing = KIT_808.filter((p) => !pathExists(path.join(root, p.file)));
      if (missing.length) {
        throw new Error("缺少采样文件: " + missing.map((m) => m.file).join(", "));
      }

      const build = async () => {
        let rack = track.devices.find(
          (d): d is DrumRack<"1.0.0"> => d instanceof DrumRack && d.chains.length === 0,
        );
        if (!rack) {
          rack = (await track.insertDevice("Drum Rack", 0)) as DrumRack<"1.0.0">;
        }
        const pads: string[] = [];
        for (const pad of KIT_808) {
          const chain = (await rack.insertChain(rack.chains.length)) as DrumChain<"1.0.0">;
          chain.receivingNote = pad.note;
          const simpler = (await chain.insertDevice("Simpler", 0)) as Simpler<"1.0.0">;
          await simpler.replaceSample(path.join(root, pad.file));
          pads.push(`${pad.note}=${pad.name}`);
        }
        return pads;
      };
      const pads = await context.withinTransaction(build);
      return trackResult(ref, { track: track.name, kit: "808", pads });
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
      if (!pathExists(filePath)) throw new Error(`文件不存在: ${filePath}`);
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
      if (!pathExists(filePath)) throw new Error(`文件不存在: ${filePath}`);
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
          const clip = await context.withinTransaction(() =>
            track.createAudioClip({
              filePath: managed,
              startTime: Number(spec.start_beat ?? 0),
              ...(typeof spec.duration_beats === "number" ? { duration: spec.duration_beats } : {}),
              ...(typeof spec.warped === "boolean" ? { isWarped: spec.warped } : {}),
            }),
          );
          imported = { track: track.name, track_index: ref.index, clip: clip.name };
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
      const notes = applySwing(parseNotes(input.notes, length), Number(input.swing ?? 0)).filter(
        (n) => n.startTime < length,
      );
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return trackResult(ref, { clip: clip.name, start, length, noteCount: notes.length, swing: Number(input.swing ?? 0) });
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
      const notes = applySwing(parseNotes(input.notes, length), Number(input.swing ?? 0)).filter(
        (n) => n.startTime < length,
      );
      clip.notes = notes;
      if (input.name) clip.name = String(input.name);
      return trackResult(ref, { clip: clip.name, length, noteCount: notes.length, swing: Number(input.swing ?? 0) });
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
      const notes = parseNotes(input.notes, clip.duration);
      clip.notes = notes;
      return trackResult(ref, { clip: clip.name, noteCount: notes.length });
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
