# Rendered track analysis

## Goal

Provide an explicit, bounded way to analyse an audio track as it is arranged
in Live, rather than only decoding the original clip source files.

## Tool

Add a read-only `analyze_rendered_track` tool.

Required input:

- `track_index`, with `track_name` recommended for stale-index protection.

Optional input:

- `start_bar` and `end_bar`, defining an inclusive bar range. Both must be
  supplied together. When omitted, use the earliest start and latest end of
  arrangement audio clips on the target track.

## Execution

1. Resolve the track by index/name and reject non-Audio Tracks.
2. Resolve and validate the beat range from the Set time signature.
3. Call `context.resources.renderPreFxAudio(track, startBeat, endBeat)`.
4. Read the returned temporary WAV/AIFF path using the existing sandbox-safe
   file access path and pass it to the existing DSP feature extractor.
5. Return the track identity, rendered range, and existing feature surface:
   RMS, crest, loudness, dynamic range, spectral centroid, transient density,
   and six-band energy.

## Semantics and safety

- The tool is explicit and never runs as a side effect of `analyze_song`.
- It performs no Set mutation and requires no confirmation.
- It is a **pre-FX render**: it represents the arrangement's rendered clip
  content and timing, but must not be described as including the track's
  device chain or master processing.
- Each call asks Live for a fresh render; no durable result cache is used.

## Errors

- Reject MIDI tracks, missing/empty arrangement audio, invalid or reversed
  ranges, Live render failure, unreadable render output, and DSP decode
  failure with actionable messages.
- An error never changes the Set or replaces the original source-file analysis.

## Verification

- Unit-test range resolution, defaults, MIDI rejection, render/file/DSP
  failures, and normalized feature output with mocked SDK calls.
- Run `npm exec tsc -- --noEmit` and `npm test`.
- Manually test one rendered range in Live, checking that the reported range
  and temporary output match the requested Audio Track.
