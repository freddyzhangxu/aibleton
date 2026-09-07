/**
 * musicstate/builder.ts — SongSnapshot -> MusicState.
 *
 * Pure functions, no SDK, no I/O. Three stages, all facts:
 * 1. windows + material: audibleWindow/materialNotes decide what actually
 *    sounds (loop region x repeats; one-shots from the start marker; muted
 *    notes/clips/tracks dropped)
 * 2. measurements: per-track counts/ranges/density/polyphony/velocity/entropy
 * 3. arrangement extent: end beat, bars, clip counts
 *
 * No key detection, no roles, no energy labels, no issues — those are
 * interpretation and live in analysis.ts.
 *
 * tileClipNotes() bakes the same materialization into a fixed-length note
 * list for arrange_song, so an arranged section matches what analysis heard.
 */

import type {
  ClipState,
  ClipWindow,
  MusicState,
  SnapshotClip,
  SnapshotNote,
  SnapshotTrack,
  SongSnapshot,
  TrackMeasurements,
  TrackState,
} from "./types.js";

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Clip windows / material
// ---------------------------------------------------------------------------

export function audibleWindow(clip: SnapshotClip): ClipWindow {
  const dur = Math.max(0, clip.duration || 0);
  if (dur <= 0) return { winStart: 0, winEnd: 0, loopLen: 0, repeats: 0 };
  if (clip.looping) {
    const ls = clip.loopStart ?? 0;
    const le = clip.loopEnd ?? 0;
    const loopLen = le - ls;
    if (loopLen > 1e-4) {
      return {
        winStart: ls,
        winEnd: le,
        loopLen,
        repeats: Math.max(1, dur / loopLen),
      };
    }
    // Degenerate loop markers: treat as one-shot.
    return { winStart: 0, winEnd: dur, loopLen: dur, repeats: 1 };
  }
  const sm = clip.startMarker ?? 0;
  return { winStart: sm, winEnd: sm + dur, loopLen: dur, repeats: 1 };
}

/** Notes inside the audible window, unmuted, velocity defaulted. */
export function materialNotes(clip: SnapshotClip, win: ClipWindow): SnapshotNote[] {
  if (clip.kind !== "midi" || !clip.notes || win.repeats <= 0) return [];
  const out: SnapshotNote[] = [];
  for (const n of clip.notes) {
    if (n.muted) continue;
    if (n.start < win.winStart - 1e-6 || n.start >= win.winEnd - 1e-6) continue;
    out.push({ ...n, velocity: n.velocity ?? 100 });
  }
  return out;
}

/**
 * Bake a clip's audible material into a fixed-length note list (beats,
 * relative to the new clip's start): a looping source tiles its loop region
 * to fill `targetLen`; a one-shot plays once and leaves the rest silent.
 * Muted notes are dropped — this bakes what analyze "hears", so an arranged
 * section matches the analysis it was planned from. Used by arrange_song.
 */
export function tileClipNotes(clip: SnapshotClip, targetLen: number): SnapshotNote[] {
  const win = audibleWindow(clip);
  const material = materialNotes(clip, win);
  if (material.length === 0 || targetLen <= 0 || win.loopLen <= 1e-4) return [];
  const passes = clip.looping ? Math.ceil(targetLen / win.loopLen) : 1;
  const out: SnapshotNote[] = [];
  for (let k = 0; k < passes; k++) {
    const off = k * win.loopLen;
    for (const n of material) {
      const start = n.start - win.winStart + off;
      if (start >= targetLen - 1e-9) continue;
      out.push({ pitch: n.pitch, start, duration: n.duration, velocity: n.velocity });
    }
    if (off + win.loopLen >= targetLen) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track measurements
// ---------------------------------------------------------------------------

function trackMeasurements(
  track: SnapshotTrack,
  barBeats: number,
  clips: ClipState[],
): TrackMeasurements | null {
  let audibleNotes = 0;
  let materialCount = 0;
  let pitchMin = Infinity;
  let pitchMax = -Infinity;
  const uniq = new Set<number>();
  let sumDur = 0;
  let firstOnset = Infinity;
  let lastOffsetSingle = -Infinity;
  let lastOffsetAudible = -Infinity;
  let velMin = Infinity;
  let velMax = -Infinity;
  let velSum = 0;
  const onsetBeatsInBar: number[] = [];
  let sessionNotes = 0;
  let mutedNotes = 0;

  for (const cm of clips) {
    const { clip, window: win, material } = cm;
    const isSession = clip.start === null;
    const base = clip.start ?? 0;
    if (clip.kind === "midi" && clip.notes) {
      mutedNotes += clip.notes.filter(
        (n) => n.muted && n.start >= win.winStart - 1e-6 && n.start < win.winEnd - 1e-6,
      ).length;
    }
    if (isSession) {
      sessionNotes += material.length;
      continue; // session clips feed the key histogram only, not timeline stats
    }
    materialCount += material.length;
    audibleNotes += Math.round(material.length * win.repeats);
    for (const n of material) {
      const rel = n.start - win.winStart;
      const onset = base + rel;
      const offSingle = onset + n.duration;
      const offAudible = offSingle + (win.repeats - 1) * win.loopLen;
      if (onset < firstOnset) firstOnset = onset;
      if (offSingle > lastOffsetSingle) lastOffsetSingle = offSingle;
      if (offAudible > lastOffsetAudible) lastOffsetAudible = offAudible;
      if (n.pitch < pitchMin) pitchMin = n.pitch;
      if (n.pitch > pitchMax) pitchMax = n.pitch;
      uniq.add(n.pitch);
      sumDur += n.duration;
      if (n.velocity < velMin) velMin = n.velocity;
      if (n.velocity > velMax) velMax = n.velocity;
      velSum += n.velocity;
      onsetBeatsInBar.push(((onset % barBeats) + barBeats) % barBeats);
    }
  }

  if (materialCount === 0) {
    return sessionNotes > 0 || mutedNotes > 0
      ? {
          audibleNotes: 0, materialCount: 0, pitchMin: 0, pitchMax: 0, uniq: 0,
          sumDur: 0, spanSingle: 0, spanAudible: 0, velMin: 0, velMax: 0, velAvg: 0,
          onsetBeatsInBar: [], sessionNotes, mutedNotes,
        }
      : null;
  }

  return {
    audibleNotes,
    materialCount,
    pitchMin,
    pitchMax,
    uniq: uniq.size,
    sumDur,
    spanSingle: Math.max(1, lastOffsetSingle - firstOnset),
    spanAudible: Math.max(barBeats, lastOffsetAudible - firstOnset),
    velMin,
    velMax,
    velAvg: velSum / materialCount,
    onsetBeatsInBar,
    sessionNotes,
    mutedNotes,
  };
}

/** Normalized onset-position entropy on a 16th-note grid. */
export function rhythmEntropy(onsetsInBar: number[], slotsPerBar: number): number | null {
  if (onsetsInBar.length < 8) return null;
  const slots = Math.max(1, Math.round(slotsPerBar));
  const counts = new Map<number, number>();
  for (const b of onsetsInBar) {
    const s = ((Math.round(b * 4) % slots) + slots) % slots;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let h = 0;
  const total = onsetsInBar.length;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  const maxH = Math.log2(slots);
  return maxH > 0 ? round2(h / maxH) : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildMusicState(input: SongSnapshot): MusicState {
  // Normalize: smoke tests and the fake-context harness pass partial objects.
  const snapshot: SongSnapshot = {
    tempo: input.tempo ?? 120,
    timeSig: input.timeSig ?? { numerator: 4, denominator: 4 },
    liveScale: input.liveScale ?? { mode: false, root: 0, name: "", intervals: [] },
    cuePoints: input.cuePoints ?? [],
    sceneCount: input.sceneCount ?? 0,
    tracks: input.tracks ?? [],
  };
  const num = snapshot.timeSig.numerator || 4;
  const den = snapshot.timeSig.denominator || 4;
  const barBeats = (num * 4) / den;

  // Per-track materialization + measurements. Muted tracks keep their clip
  // shells (empty material) so muted content stays countable.
  const tracks: TrackState[] = snapshot.tracks.map((track) => {
    const muted = track.mute || track.mutedViaSolo;
    const clips: ClipState[] = track.clips.map((clip) => {
      const win = audibleWindow(clip);
      return { clip, window: win, material: clip.muted || muted ? [] : materialNotes(clip, win) };
    });
    const measurements = muted ? null : trackMeasurements(track, barBeats, clips);
    return { track, muted, clips, measurements };
  });

  // Arrangement extent (any clip kind counts, muted or not — it still occupies time).
  let endBeat = 0;
  let hasClips = false;
  let midiClips = 0;
  for (const ts of tracks) {
    for (const cm of ts.clips) {
      if (cm.clip.start === null) continue;
      hasClips = true;
      if (cm.clip.kind === "midi") midiClips++;
      const end = cm.clip.start + Math.max(0, cm.clip.duration);
      if (end > endBeat) endBeat = end;
    }
  }

  return {
    snapshot,
    barBeats,
    tracks,
    arrangement: {
      endBeat,
      bars: endBeat > 0 ? endBeat / barBeats : 0,
      hasClips,
      midiClips,
    },
  };
}
