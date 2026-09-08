/**
 * analysis/present.ts — MusicState + MusicAnalysis -> SongAnalysis: the
 * model-facing rendering of the interpretation layer.
 *
 * Everything presentational lives here and only here: number rounding, range
 * strings ("F#1-C#2"), issue stringification ("CODE: message"), the flat clip
 * map arrange_song plans against, the session summary, and fitBudget — the
 * staged cuts that keep the JSON inside the callTool character budget.
 * Machine consumers should use MusicAnalysis (interpret.ts), not this output.
 *
 * With a ContextSelection (select.ts, from analyze_song's focus param) the
 * same content is rendered as a focused projection: selected tracks keep
 * full stats, the rest collapse to one-line base rows; the clip map keeps
 * only selected tracks' entries; sections gain focusTracks activity markers;
 * relevant issues sort first. Unmatched selections fall back to the full
 * render with a focus.unmatched echo.
 */

import { rhythmEntropy } from "../musicstate/builder.js";
import type { MusicState } from "../musicstate/types.js";
import type { ContextSelection } from "./select.js";
import type {
  ClipEntry,
  MusicAnalysis,
  SongAnalysis,
  TrackAnalysis,
} from "./types.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const CAVEAT =
  "MIDI/structure-based only: audio clips contribute filename + duration, " +
  "no loudness/timbre/pitch analysis. Loop repeats estimated virtually " +
  "(material x repeats). Track indices match get_song_overview.";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pitchName(p: number): string {
  const c = Math.max(0, Math.min(127, Math.round(p)));
  return NOTE_NAMES[c % 12] + (Math.floor(c / 12) - 1);
}

function pcName(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------------------
// Budget fitting (callTool hard-truncates at 6000 chars)
// ---------------------------------------------------------------------------

function fitBudget(analysis: SongAnalysis, budget = 5800): SongAnalysis {
  const size = () => JSON.stringify(analysis).length;
  if (size() <= budget) return analysis;
  for (const t of analysis.tracks) {
    if (t.audio?.files) delete t.audio.files;
  }
  if (size() <= budget) return analysis;
  if (analysis.tracks.length > 12) {
    analysis.tracksOmitted = (analysis.tracksOmitted ?? 0) + analysis.tracks.length - 12;
    analysis.tracks = analysis.tracks.slice(0, 12);
  }
  if (size() <= budget) return analysis;
  if (analysis.key.candidates && analysis.key.candidates.length > 1) {
    analysis.key.candidates = analysis.key.candidates.slice(0, 1);
  }
  if (size() <= budget) return analysis;
  if (analysis.sections.length > 12) {
    analysis.sections = [...analysis.sections.slice(0, 6), ...analysis.sections.slice(-6)];
  }
  if (size() <= budget) return analysis;
  // Keep the clip map longest — it is the coordinate system arrange_song
  // plans against. Drop loop annotations first, then cap the list.
  for (const c of analysis.clips) delete c.loop;
  if (size() <= budget) return analysis;
  if (analysis.clips.length > 40) {
    analysis.clipsOmitted = (analysis.clipsOmitted ?? 0) + analysis.clips.length - 40;
    analysis.clips = analysis.clips.slice(0, 40);
  }
  return analysis;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Presentation entry point: render MusicAnalysis (plus facts from MusicState
 * it references by index) as model-bound SongAnalysis JSON.
 * budget: JSON char cap; null = no fitBudget cut.
 * selection: from selectMusicContext; omitted = full render (unchanged). */
export function presentAnalysis(
  state: MusicState,
  ma: MusicAnalysis,
  budget: number | null = 5800,
  selection?: ContextSelection,
): SongAnalysis {
  const snap = state.snapshot;
  const num = snap.timeSig.numerator || 4;
  const den = snap.timeSig.denominator || 4;
  const barBeats = state.barBeats;
  const arrEnd = state.arrangement.endBeat;
  const arrangementBars = state.arrangement.bars;

  // Session summary (facts re-counted from the state — interpret.ts doesn't
  // carry the notes/tracks aggregates its issue rules don't need).
  let sessionClipCount = 0;
  let sessionNotes = 0;
  const sessionTracks = new Set<number>();
  for (const ts of state.tracks) {
    for (const cs of ts.clips) {
      const c = cs.clip;
      if (c.start === null && !c.muted && c.kind === "midi") {
        sessionClipCount++;
        sessionNotes += cs.material.length;
        if (cs.material.length > 0) sessionTracks.add(ts.track.index);
      }
    }
  }

  const trackAnalyses: TrackAnalysis[] = state.tracks.map((ts, idx) => {
    const track = ts.track;
    const feats = ts.measurements;
    const arrClipCount = track.clips.filter((c) => c.start !== null).length;
    const base: TrackAnalysis = {
      i: track.index,
      name: track.name,
      role: ma.trackRoles[idx]?.role ?? "unknown",
      notes: feats?.audibleNotes ?? 0,
      clips: arrClipCount,
    };
    if (track.mute || track.mutedViaSolo) base.muted = true;
    const audioClips = track.clips.filter((c) => c.kind === "audio" && c.start !== null);
    if (feats && feats.materialCount > 0) {
      base.range = `${pitchName(feats.pitchMin)}-${pitchName(feats.pitchMax)}`;
      base.dens = round1(feats.audibleNotes / Math.max(1, feats.spanAudible / barBeats));
      base.poly = round2(feats.sumDur / feats.spanSingle);
      base.vel = [Math.round(feats.velMin), Math.round(feats.velMax), Math.round(feats.velAvg)];
      const ent = rhythmEntropy(feats.onsetBeatsInBar, barBeats * 4);
      if (ent !== null) base.ent = ent;
      base.uniq = feats.uniq;
    } else if (audioClips.length > 0) {
      base.audio = {
        clips: audioClips.length,
        bars: round1(audioClips.reduce((a, c) => a + Math.max(0, c.duration), 0) / barBeats),
        files: audioClips.map((c) => c.file ?? c.name).filter(Boolean).slice(0, 4),
      };
    }
    return base;
  });

  // Flat clip map — arrange_song plans against these coordinates. Arrangement
  // clips first (sorted by position), then session clips (by slot index).
  const clips: ClipEntry[] = [];
  for (const ts of state.tracks) {
    const track = ts.track;
    const arr = track.clips
      .filter((c) => c.start !== null)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const ses = track.clips
      .filter((c) => c.start === null)
      .sort((a, b) => (a.scene ?? 0) - (b.scene ?? 0));
    for (const c of arr) {
      const e: ClipEntry = {
        t: track.index,
        i: c.arrIndex,
        name: c.name,
        kind: c.kind,
        bar: round1((c.start ?? 0) / barBeats) + 1,
        bars: round1(Math.max(0, c.duration) / barBeats),
      };
      if (c.looping && c.loopEnd - c.loopStart > 1e-4) {
        e.loop = round1((c.loopEnd - c.loopStart) / barBeats);
      }
      if (c.muted) e.muted = true;
      clips.push(e);
    }
    for (const c of ses) {
      const e: ClipEntry = {
        t: track.index,
        scene: c.scene,
        name: c.name,
        kind: c.kind,
        bars: round1(Math.max(0, c.duration) / barBeats),
      };
      if (c.looping && c.loopEnd - c.loopStart > 1e-4) {
        e.loop = round1((c.loopEnd - c.loopStart) / barBeats);
      }
      if (c.muted) e.muted = true;
      clips.push(e);
    }
  }

  // --- Focused projection (select.ts) -------------------------------------
  // focused: a selection that resolved to at least one track. Section-name-
  // only matches stay echo-only (no track/clip projection).
  const focused =
    selection !== undefined && !selection.unmatched && selection.trackIndices.size > 0;

  let tracksOut = trackAnalyses;
  let clipsOut = clips;
  let clipsProjectionOmitted = 0;
  let sectionsOut = ma.sections;
  let issuesOut = ma.issues.map((i) => `${i.code}: ${i.message}`);
  if (selection && !selection.unmatched) {
    if (focused) {
      // Selected tracks keep full rows; the rest collapse to their base row
      // (i/name/role/notes/clips[/muted]) so coordinates stay addressable.
      tracksOut = trackAnalyses.map((full, idx) => {
        if (selection.trackIndices.has(state.tracks[idx].track.index)) return full;
        const compact: TrackAnalysis = {
          i: full.i,
          name: full.name,
          role: full.role,
          notes: full.notes,
          clips: full.clips,
        };
        if (full.muted) compact.muted = true;
        return compact;
      });
      clipsOut = clips.filter((c) => selection.trackIndices.has(c.t));
      clipsProjectionOmitted = clips.length - clipsOut.length;
      // Every section carries the selected tracks active in it ([] = none —
      // "bass silent in the Drop" is exactly what a focus call is for).
      sectionsOut = ma.sections.map((s) => ({
        ...s,
        focusTracks: selection.sectionFocus.get(s.name) ?? [],
      }));
    }
    // Relevant issues first, the rest after.
    if (selection.relevantIssues.length > 0) {
      const relevant = new Set(selection.relevantIssues);
      const fmt = (i: (typeof ma.issues)[number]) => `${i.code}: ${i.message}`;
      issuesOut = [
        ...ma.issues.filter((i) => relevant.has(i)).map(fmt),
        ...ma.issues.filter((i) => !relevant.has(i)).map(fmt),
      ];
    }
  }

  const analysis: SongAnalysis = {
    tempo: snap.tempo ?? 120,
    timeSig: `${num}/${den}`,
    liveScale: snap.liveScale?.mode
      ? { mode: true, root: pcName(snap.liveScale.root), name: snap.liveScale.name }
      : null,
    key: {
      // Whitelist copy (never spread): interpret.ts's internal KeyResult
      // carries root/mode which must not leak into model-bound JSON.
      status: ma.key.status,
      best: ma.key.best,
      confidence: ma.key.confidence,
      r: ma.key.r !== undefined ? round2(ma.key.r) : undefined,
      margin: ma.key.margin !== undefined ? round2(ma.key.margin) : undefined,
      candidates: ma.key.candidates?.map(([l, r]) => [l, round2(r)] as [string, number]),
    },
    arrangement: arrEnd > 0 ? { bars: round1(arrangementBars), beats: round1(arrEnd) } : null,
    sections: sectionsOut,
    tracks: tracksOut,
    clips: clipsOut,
    session: {
      scenes: snap.sceneCount ?? 0,
      clips: sessionClipCount,
      tracks: sessionTracks.size,
      notes: sessionNotes,
    },
    issues: issuesOut,
    caveat: CAVEAT,
  };
  if (clipsProjectionOmitted > 0) analysis.clipsOmitted = clipsProjectionOmitted;
  if (selection) {
    analysis.focus = selection.unmatched
      ? { raw: selection.focusRaw, matched: selection.matched, unmatched: true }
      : { raw: selection.focusRaw, matched: selection.matched };
  }
  return budget === null ? analysis : fitBudget(analysis, budget);
}
