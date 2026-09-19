# Track send control

## Goal

Allow AIbleton to set a track's send levels to Live Return Tracks through the
existing `set_track_mixer` tool.

## Design

Add an optional `sends` array to `set_track_mixer` input. Each entry has an
`index` and `value`; send index 0 maps to Return Track 0 (Send A), index 1 to
Return Track 1 (Send B), and so on. Limit one call to 12 entries.

Use `track.mixer.sends[index]` and the existing clamping setter. Resolve the
matching `song.returnTracks[index]` name for the result. Return every applied
send with its index, Return Track name, and clamped value, alongside any volume
or pan update.

## Errors and scope

- Reject non-integer/out-of-range Send indices with a clear message.
- Keep existing confirmation, verification, and listening-hint paths because
  this remains a `set_track_mixer` mutation.
- Update the model prompt: sends are controllable; sidechain input routing is
  still not exposed by the SDK.
- Do not create a new tool or add routing/sidechain-source support.

## Verification

- Unit-test send mapping, clamp behaviour, invalid indices, and mixed
  volume/pan/send updates with mocked mixer parameters.
- Run `npm exec tsc -- --noEmit` and `npm test`.
