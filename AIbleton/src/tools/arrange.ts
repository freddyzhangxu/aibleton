import {
  AudioClip,
  AudioTrack,
  MidiClip,
  MidiTrack,
  type Clip,
  type ClipLoopSettings,
  type NoteDescription,
} from "@ableton-extensions/sdk";
import { tileClipNotes } from "../musicstate/builder.js";
import type { Ctx } from "../state.js";
import { resolveTrack, snapshotClip, toNum, type TrackRef } from "./helpers.js";

// ---------- arrange_song ----------

interface ResolvedPlacement {
  ref: TrackRef;
  kind: "midi" | "audio";
  srcName: string;
  srcDesc: string; // e.g. 编排 clip 2“Loop A” / 场景 3“Loop A”
  startBeat: number;
  lenBeats: number;
  name?: string;
  color: number;
  muted: boolean;
  notes: NoteDescription[]; // midi only, already tiled/trimmed to lenBeats
  filePath?: string; // audio only
  isWarped?: boolean;
  loopSettings?: ClipLoopSettings;
  warning?: string;
}

/**
 * Compiles a placement plan into arrangement clips. Everything is resolved
 * and validated (references, overlaps) BEFORE any mutation, so a bad plan
 * fails with zero writes; execution is one transaction = one undo step.
 * Source clips are read into plain data up front — clear_range_bars may
 * delete them, and SDK objects throw once their Live object is gone.
 */
export async function arrangeSong(context: Ctx, input: Record<string, unknown>): Promise<unknown> {
  const song = context.application.song;
  const scenes = song.scenes ?? [];
  const num = toNum(scenes[0]?.signatureNumerator) || 4;
  const den = toNum(scenes[0]?.signatureDenominator) || 4;
  const barBeats = (num * 4) / den;
  const round1 = (x: number) => Math.round(x * 10) / 10;

  const rawPlacements = Array.isArray(input.placements) ? input.placements : null;
  if (!rawPlacements) throw new Error("请提供 placements 数组（只清场不传 placements 时传 []）");
  if (rawPlacements.length > 128) {
    throw new Error(`一次最多 128 个 placement（当前 ${rawPlacements.length} 个）——请分段执行`);
  }

  // const (via IIFE) so closures below keep the narrowing.
  const clear = ((): { startBar: number; endBar: number; startBeat: number; endBeat: number } | null => {
    if (input.clear_range_bars === undefined || input.clear_range_bars === null) return null;
    const cr = input.clear_range_bars;
    if (!Array.isArray(cr) || cr.length !== 2) {
      throw new Error("clear_range_bars 须为 [起始小节, 结束小节]（含端点）");
    }
    const a = Number(cr[0]);
    const b = Number(cr[1]);
    if (!(a >= 1) || !(b >= a)) throw new Error("clear_range_bars 须满足 1 ≤ 起始小节 ≤ 结束小节");
    return { startBar: a, endBar: b, startBeat: (a - 1) * barBeats, endBeat: b * barBeats };
  })();
  if (rawPlacements.length === 0 && !clear) {
    throw new Error("placements 为空且未给 clear_range_bars —— 无事可做");
  }

  // ---- Phase 1: resolve + read every source into plain data ----
  const problems: string[] = [];
  const resolved: ResolvedPlacement[] = [];

  rawPlacements.forEach((raw, pi) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const label = `placement ${pi + 1}`;
    const startBar = Number(p.start_bar);
    const lenBars = Number(p.length_bars);
    if (!(startBar >= 1)) {
      problems.push(`${label}: start_bar 须 ≥ 1（1 起计）`);
      return;
    }
    if (!(lenBars > 0)) {
      problems.push(`${label}: length_bars 须 > 0`);
      return;
    }
    const hasArr = typeof p.clip_index === "number";
    const hasSes = typeof p.scene_index === "number";
    if (hasArr === hasSes) {
      problems.push(`${label}: clip_index（编排区源）与 scene_index（Session 源）必须且只能给一个`);
      return;
    }
    let ref: TrackRef;
    try {
      ref = resolveTrack(context, p, "track_index");
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message}`);
      return;
    }
    const track = ref.track;

    let clip: Clip<"1.0.0"> | null | undefined;
    let srcDesc: string;
    if (hasArr) {
      const ci = Number(p.clip_index);
      clip = track.arrangementClips[ci];
      if (!clip) {
        problems.push(
          `${label}: 轨道 ${ref.index}（${track.name}）上没有编排 clip ${ci}（共 ${track.arrangementClips.length} 个，0 起计）`,
        );
        return;
      }
      srcDesc = `编排 clip ${ci}`;
    } else {
      const si = Number(p.scene_index);
      clip = track.clipSlots[si]?.clip;
      if (!clip) {
        problems.push(`${label}: 轨道 ${ref.index}（${track.name}）的场景 ${si} 是空槽`);
        return;
      }
      srcDesc = `场景 ${si}`;
    }

    const rp: ResolvedPlacement = {
      ref,
      kind: "midi",
      srcName: String(clip.name ?? ""),
      srcDesc: `${srcDesc}“${clip.name}”`,
      startBeat: (startBar - 1) * barBeats,
      lenBeats: lenBars * barBeats,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined,
      color: toNum(clip.color),
      muted: !!clip.muted,
      notes: [],
    };

    if (clip instanceof MidiClip) {
      const snap = snapshotClip(clip, hasArr ? toNum(clip.startTime) : null);
      rp.kind = "midi";
      rp.notes = tileClipNotes(snap, rp.lenBeats).map((n) => ({
        pitch: n.pitch,
        startTime: n.start,
        duration: n.duration,
        velocity: n.velocity,
      }));
      if (rp.notes.length === 0) rp.warning = "源 clip 没有可闻音符，将创建空 clip";
    } else if (clip instanceof AudioClip) {
      rp.kind = "audio";
      rp.filePath = String(clip.filePath ?? "");
      if (!rp.filePath) {
        problems.push(`${label}: ${rp.srcDesc} 没有文件路径，无法复制`);
        return;
      }
      rp.isWarped = !!clip.warping;
      rp.loopSettings = {
        looping: !!clip.looping,
        startMarker: toNum(clip.startMarker),
        endMarker: toNum(clip.endMarker),
        loopStart: toNum(clip.loopStart),
        loopEnd: toNum(clip.loopEnd),
      };
    } else {
      problems.push(`${label}: ${rp.srcDesc} 类型不受支持`);
      return;
    }
    resolved.push(rp);
  });

  // ---- Phase 2: overlap check (per track): plan vs plan, plan vs what
  // survives the cleared range. Existing clips are trimmed virtually. ----
  if (problems.length === 0) {
    interface Iv {
      s: number;
      e: number;
      what: string;
    }
    const perTrack = new Map<number, Iv[]>();
    const push = (ti: number, iv: Iv) => {
      const list = perTrack.get(ti) ?? [];
      list.push(iv);
      perTrack.set(ti, list);
    };
    song.tracks.forEach((t, ti) => {
      for (const c of t.arrangementClips) {
        const s = toNum(c.startTime);
        const e = toNum(c.endTime);
        let segs = [{ s, e }];
        if (clear) {
          segs = segs.flatMap((g) => {
            if (g.e <= clear.startBeat || g.s >= clear.endBeat) return [g];
            const out: { s: number; e: number }[] = [];
            if (g.s < clear.startBeat) out.push({ s: g.s, e: clear.startBeat });
            if (g.e > clear.endBeat) out.push({ s: clear.endBeat, e: g.e });
            return out;
          });
        }
        for (const g of segs) {
          if (g.e - g.s > 1e-9) push(ti, { ...g, what: `已有 clip“${c.name}”` });
        }
      }
    });
    resolved.forEach((r, pi) => {
      push(r.ref.index, {
        s: r.startBeat,
        e: r.startBeat + r.lenBeats,
        what: `placement ${pi + 1}（${r.srcDesc}）`,
      });
    });
    const bar = (b: number) => round1(b / barBeats + 1);
    for (const [ti, ivs] of perTrack) {
      ivs.sort((a, b2) => a.s - b2.s);
      let maxE = -Infinity;
      let maxWhat = "";
      for (const iv of ivs) {
        if (iv.s < maxE - 1e-9) {
          problems.push(
            `轨道 ${ti}（${song.tracks[ti]?.name ?? "?"}）：${maxWhat} 与 ${iv.what} 在小节 ${bar(iv.s)} 附近重叠——同一轨道的编排 clip 不能重叠`,
          );
        }
        if (iv.e > maxE) {
          maxE = iv.e;
          maxWhat = iv.what;
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`编排计划未通过校验，未对 Set 做任何改动：\n- ${problems.join("\n- ")}`);
  }

  // ---- What clear_range_bars would remove (reported in both dry_run and real run) ----
  let clearInfo: Record<string, unknown> | null = null;
  if (clear) {
    let affected = 0;
    const tracksHit = new Set<number>();
    song.tracks.forEach((t, ti) => {
      for (const c of t.arrangementClips) {
        const s = toNum(c.startTime);
        const e = toNum(c.endTime);
        if (e > clear.startBeat && s < clear.endBeat) {
          affected++;
          tracksHit.add(ti);
        }
      }
    });
    clearInfo = { range_bars: [clear.startBar, clear.endBar], clips_affected: affected, tracks: tracksHit.size };
  }

  const planOut = resolved.map((r, pi) => ({
    placement: pi + 1,
    track_index: r.ref.index,
    track: r.ref.track.name,
    source: r.srcDesc,
    start_bar: round1(r.startBeat / barBeats + 1),
    length_bars: round1(r.lenBeats / barBeats),
    kind: r.kind,
    ...(r.kind === "midi" ? { notes: r.notes.length } : {}),
    name: r.name ?? r.srcName,
    ...(r.ref.refreshedFrom !== undefined
      ? { index_refreshed: `轨道索引已漂移（${r.ref.refreshedFrom} → ${r.ref.index}），已按名称重新定位` }
      : {}),
    ...(r.warning ? { warning: r.warning } : {}),
  }));

  if (input.dry_run === true) {
    return {
      dry_run: true,
      bar_beats: barBeats,
      ...(clearInfo ? { would_clear: clearInfo } : {}),
      placements: planOut,
      note: "校验通过，未改动 Set —— 去掉 dry_run 再调用即执行",
    };
  }

  // ---- Phase 3: execute — one transaction, one undo step ----
  await context.withinTransaction(async () => {
    if (clear) {
      for (const t of song.tracks) {
        await t.clearClipsInRange(clear.startBeat, clear.endBeat);
      }
    }
    for (const r of resolved) {
      if (r.kind === "midi") {
        const track = r.ref.track;
        if (!(track instanceof MidiTrack)) {
          throw new Error(`轨道 ${r.ref.index}（${track.name}）不是 MIDI 轨道`);
        }
        const clip = await track.createMidiClip(r.startBeat, r.lenBeats);
        clip.notes = r.notes;
        clip.name = r.name ?? r.srcName;
        if (r.color) clip.color = r.color;
        if (r.muted) clip.muted = true;
      } else {
        const track = r.ref.track;
        if (!(track instanceof AudioTrack)) {
          throw new Error(`轨道 ${r.ref.index}（${track.name}）不是音频轨道`);
        }
        // isWarped + loopSettings always travel together (SDK requires
        // isWarped whenever loopSettings is given); both are read from the
        // source clip, so the pair is always consistent.
        const clip = await track.createAudioClip({
          filePath: r.filePath as string,
          startTime: r.startBeat,
          duration: r.lenBeats,
          isWarped: r.isWarped ?? false,
          loopSettings: r.loopSettings,
        });
        clip.name = r.name ?? r.srcName;
        if (r.color) clip.color = r.color;
        if (r.muted) clip.muted = true;
      }
    }
  });

  return {
    arranged: true,
    bar_beats: barBeats,
    ...(clearInfo ? { cleared: clearInfo } : {}),
    placements: planOut,
    clips_created: resolved.length,
    undo: "整个计划是一个事务——在 Live 里按一次 ⌘Z 即可全部撤销",
  };
}
