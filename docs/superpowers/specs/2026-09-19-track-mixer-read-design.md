# Track mixer read

## Goal

Add a read-only `get_track_mixer` tool so AIbleton can inspect a track's
volume, pan, and Return Track send levels before proposing or applying a mix
change.

## Design

The tool accepts `track_index` and optional `track_name`, using the existing
stale-index resolver. It reads volume, panning, and every `track.mixer.sends`
parameter concurrently. Each send result includes its zero-based index, the
matching `song.returnTracks[index]` name, and current value. Return up to 12
sends.

The tool is read-only, needs no confirmation, and is added to the read-only
tool set. The prompt documents the workflow: `get_track_mixer` before
`set_track_mixer` for an intentional send/mixer adjustment.

## Verification

- Test no-send, mapped Send A/B names, and stale name/index resolution.
- Run `npm exec tsc -- --noEmit` and `npm test`.
