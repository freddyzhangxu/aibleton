import type { Ctx } from "../state.js";
import { toNum } from "./helpers.js";

/**
 * Deterministic "what to listen to now" hint, attached to successful mutating
 * tool results as `listen_hint`. The model is unreliable at volunteering this
 * (especially weak tool-calling models), so it is computed here from the call
 * itself — never from model output. The UI renders it as a card and the model
 * can quote it in its reply.
 */
export type ListenHint = {
  /** Affected track names (deduped, order preserved). */
  tracks: string[];
  /** 1-based first bar worth hearing. Absent for session-view-only changes. */
  start_bar?: number;
  /** 1-based last bar; only present when it differs from start_bar. */
  end_bar?: number;
  /** Track worth soloing to judge the change (only when it isn't solo/muted). */
  suggest_solo?: string;
  /** True when the change replaced existing material — worth an A/B. */
  suggest_ab?: boolean;
};

function barBeatsOf(context: Ctx): number {
  const scenes = context.application.song.scenes ?? [];
  const num = toNum(scenes[0]?.signatureNumerator) || 4;
  const den = toNum(scenes[0]?.signatureDenominator) || 4;
  return (num * 4) / den;
}

function trackNameAt(context: Ctx, index: unknown): string | undefined {
  if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
  return context.application.song.tracks[index]?.name;
}

/** Solo suggestion: exactly one affected track, others exist, it's not
 * already solo and not muted (in Live a muted track stays silent under solo). */
function soloFor(context: Ctx, tracks: string[]): string | undefined {
  if (tracks.length !== 1) return undefined;
  const song = context.application.song;
  if (song.tracks.length < 2) return undefined;
  const t = song.tracks.find((tr) => tr.name === tracks[0]);
  if (!t || t.solo || t.mute) return undefined;
  return t.name;
}

/** Did this track hold arrangement clips before this call added one? */
function hadPriorClips(context: Ctx, index: unknown): boolean {
  if (typeof index !== "number") return false;
  const t = context.application.song.tracks[index];
  return !!t && t.arrangementClips.length > 1;
}

export function listenHintFor(
  context: Ctx,
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): ListenHint | undefined {
  const barBeats = barBeatsOf(context);
  const bars = (startBeat: number, lenBeats?: number): Pick<ListenHint, "start_bar" | "end_bar"> => {
    const startBar = Math.floor(startBeat / barBeats) + 1;
    const endBar = lenBeats && lenBeats > 0 ? Math.ceil((startBeat + lenBeats) / barBeats) : startBar;
    return endBar > startBar ? { start_bar: startBar, end_bar: endBar } : { start_bar: startBar };
  };
  const finish = (tracks: string[], rest: Partial<ListenHint>): ListenHint | undefined => {
    const unique = [...new Set(tracks.filter(Boolean))];
    if (!unique.length) return undefined;
    const hint: ListenHint = { tracks: unique, ...rest };
    const solo = soloFor(context, unique);
    if (solo) hint.suggest_solo = solo;
    return hint;
  };
  const one = (r: Record<string, unknown>): string[] => {
    const n = trackNameAt(context, r.track_index) ?? (typeof r.track === "string" ? r.track : undefined);
    return n ? [n] : [];
  };

  switch (name) {
    case "write_midi_clip":
      return finish(one(result), bars(toNum(result.start), toNum(result.length)));
    case "set_clip_notes":
      return finish(one(result), {
        ...bars(toNum(result.start), toNum(result.length)),
        suggest_ab: true, // overwrote an existing clip's notes
      });
    case "write_session_clip":
      return finish(one(result), {}); // session slot — no arrangement bar
    case "import_audio_clip":
      return finish(one(result), {
        // Session slot — no arrangement bar
        ...(typeof input.scene_index === "number"
          ? {}
          : bars(toNum(input.start_beat), toNum(input.duration_beats))),
        ...(hadPriorClips(context, result.track_index) ? { suggest_ab: true } : {}),
      });
    case "generate_audio": {
      const imported = result.imported as Record<string, unknown> | undefined;
      if (!imported) return undefined; // file only, nothing in the Set yet
      const spec = (input.importTo ?? {}) as Record<string, unknown>;
      return finish(one(imported), {
        ...(typeof spec.scene_index === "number"
          ? {}
          : bars(toNum(spec.start_beat), toNum(spec.duration_beats))),
        ...(hadPriorClips(context, imported.track_index) ? { suggest_ab: true } : {}),
      });
    }
    case "arrange_song": {
      const placements = Array.isArray(result.placements)
        ? (result.placements as Record<string, unknown>[])
        : [];
      const tracks = placements.map((p) => String(p.track ?? ""));
      const starts = placements.map((p) => toNum(p.start_bar)).filter((n) => n >= 1);
      const ends = placements
        .map((p) => toNum(p.start_bar) + toNum(p.length_bars))
        .filter((n) => n >= 1);
      const rest: Partial<ListenHint> = {};
      if (starts.length) {
        rest.start_bar = Math.min(...starts);
        const end = Math.ceil(Math.max(...ends)) - 1;
        if (end > rest.start_bar) rest.end_bar = end;
      }
      if (result.cleared) rest.suggest_ab = true; // rebuilt over deleted clips
      return finish(tracks, rest);
    }
    case "set_device_parameter":
    case "set_device_parameters":
    case "set_track_mixer":
    case "load_drum_kit":
    case "load_sample":
    case "insert_device":
      // Track-level timbre change — no single bar; hear it in context.
      return finish(one(result), {});
    default:
      return undefined;
  }
}
