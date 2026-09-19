import { AudioClip, AudioTrack } from "@ableton-extensions/sdk";
import { featuresFromBuffer } from "../dsp.js";
import { readHomeBinary } from "../paths.js";
import { toolState, type Ctx } from "../state.js";
import { resolveTrack, toNum, trackResult } from "./helpers.js";

function round(x: number, places = 2): number {
  const p = 10 ** places;
  return Math.round(x * p) / p;
}

function barBeats(context: Ctx): number {
  const scene = context.application.song.scenes[0];
  return (toNum(scene?.signatureNumerator) || 4) * 4 / (toNum(scene?.signatureDenominator) || 4);
}

function renderRange(track: AudioTrack<"1.0.0">, input: Record<string, unknown>, beatsPerBar: number) {
  const hasStart = input.start_bar !== undefined;
  const hasEnd = input.end_bar !== undefined;
  if (hasStart !== hasEnd) throw new Error("start_bar 和 end_bar 必须同时提供");
  if (hasStart) {
    const startBar = Number(input.start_bar);
    const endBar = Number(input.end_bar);
    if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || startBar < 1 || endBar < startBar) {
      throw new Error("小节范围须满足 1 ≤ start_bar ≤ end_bar（均为整数）");
    }
    return { startBeat: (startBar - 1) * beatsPerBar, endBeat: endBar * beatsPerBar, bars: [startBar, endBar] as [number, number] };
  }
  const clips = track.arrangementClips.filter((clip): clip is AudioClip<"1.0.0"> => clip instanceof AudioClip);
  if (!clips.length) throw new Error(`轨道“${track.name}”没有编排区 Audio Clip；请提供有音频素材的 Audio Track`);
  const startBeat = Math.min(...clips.map((clip) => toNum(clip.startTime)));
  const endBeat = Math.max(...clips.map((clip) => toNum(clip.endTime)));
  if (!(endBeat > startBeat)) throw new Error(`轨道“${track.name}”没有可渲染的音频范围`);
  return {
    startBeat,
    endBeat,
    bars: [Math.floor(startBeat / beatsPerBar) + 1, Math.ceil(endBeat / beatsPerBar)] as [number, number],
  };
}

/** Render an arrangement range through Live's pre-FX renderer, then run the
 * existing WAV/AIFF DSP pipeline. It is intentionally separate from
 * analyze_song: rendering is expensive and always user-requested. */
export async function analyzeRenderedTrack(context: Ctx, input: Record<string, unknown>): Promise<unknown> {
  const ref = resolveTrack(context, input, "track_index");
  const audioTrack = ref.track;
  if (!(audioTrack instanceof AudioTrack)) {
    throw new Error(`轨道 ${ref.index}（${ref.track.name}）不是 Audio Track；只能渲染编排区的音频轨道`);
  }
  const range = renderRange(audioTrack, input, barBeats(context));
  return await context.ui.withinProgressDialog(
    "正在从 Live 渲染音频…",
    { progress: 15 },
    async (update, signal) => {
      let filePath: string;
      try {
        filePath = await context.resources.renderPreFxAudio(audioTrack, range.startBeat, range.endBeat);
      } catch (error) {
        throw new Error(`Live 预效果渲染失败：${error instanceof Error ? error.message : String(error)}`);
      }
      // The public SDK cannot interrupt an in-flight render. Honour a cancel
      // immediately afterwards by skipping all file I/O and DSP work.
      if (signal.aborted) throw new Error("用户已取消渲染分析");
      toolState.phase = "analyzing_render";
      await update("正在读取并分析渲染音频…", 70);
      if (signal.aborted) throw new Error("用户已取消渲染分析");
      const bytes = readHomeBinary(filePath);
      if (!bytes) throw new Error("渲染文件无法读取；请检查 Extension Host 的临时目录访问权限");
      const outcome = featuresFromBuffer(filePath, bytes, { maxSeconds: 180 });
      if ("error" in outcome) throw new Error(`渲染文件无法分析：${outcome.error}`);
      const f = outcome.features;
      return trackResult(ref, {
        track: ref.track.name,
        render: "pre_fx",
        range_bars: range.bars,
        range_beats: [round(range.startBeat), round(range.endBeat)],
        duration_seconds: round(f.durationSec),
        sample_rate: f.sampleRate,
        channels: f.channels,
        features: {
          rms_db: round(f.rmsDb), peak_db: round(f.peakDb), crest_db: round(f.crestDb),
          loudness_db: round(f.loudnessDb), spectral_centroid_hz: round(f.spectralCentroidHz),
          ...(f.dynamicRangeDb !== undefined ? { dynamic_range_db: round(f.dynamicRangeDb) } : {}),
          ...(f.transientDensity !== undefined ? { transient_density: round(f.transientDensity, 3) } : {}),
          bands: Object.fromEntries(Object.entries(f.bands).map(([band, value]) => [band, round(value, 3)])),
          ...(f.partial ? { partial: true } : {}),
        },
        caveat: "Pre-FX render: reflects the arrangement range and clip timing, but not the track device chain or master processing.",
      });
    },
  );
}
