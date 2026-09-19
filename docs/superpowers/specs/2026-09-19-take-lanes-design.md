# Take Lanes Design

## Scope

Add a non-destructive candidate-version workflow on Ableton Live Take Lanes.
The agent can create, inspect, name, and write MIDI or audio candidates into a
selected track's Take Lane while leaving existing arrangement clips unchanged.

## User outcome

When a user asks for alternatives—such as a second bassline, an alternate drum
fill, or another vocal/audio idea—AIbleton creates a named candidate lane and
places the result there. The user can keep and audition several versions in
Live without relying on Undo or duplicating an entire track.

The first release does not comp takes, move existing arrangement clips into a
lane, choose a winner automatically, or claim that a lane is individually
audible. Those controls are not available in the SDK.

## Tools

Expose four provider-neutral tools:

- `list_take_lanes`: read a regular track's lane index, name, and clips.
- `create_take_lane`: append a Take Lane to a regular track and optionally
  name it.
- `write_take_midi_clip`: create a MIDI clip in a specified lane, validate and
  write notes with the same grid/swing conventions as `write_midi_clip`.
- `import_take_audio_clip`: import an audio file into the Live project and
  create an arrangement audio clip in a specified Take Lane.

`create_take_lane` is separate from write/import so users can explicitly
organize lanes. Write/import accept a lane index and never create a fallback
lane silently.

## Context and selection policy

The selection boundary implemented in the preceding feature applies equally:

- A track target must be selected when a selection is active.
- For an Arrangement selection, a candidate clip's beat range must lie wholly
  in the selected range.
- For a Session selection, only its selected tracks may receive a Take Lane
  candidate; Session slots do not map to arrangement lanes.
- The current user can explicitly request a whole-song/global operation to
  bypass these checks for that turn only.

## Implementation structure

`tools/dispatcher.ts` will own the small SDK mutations and reuse existing
track resolution, note parsing, snapping, swing, import, and transaction
patterns. A dedicated `take-lanes.ts` helper will keep lane lookup and compact
presentation in one place so no other tool needs to know the SDK's lane shape.

`get_song_overview` will include each track's Take Lane count. `analyze_song`
will remain focused on the current audible arrangement and will not infer that
a Take Lane is audible; a later iteration may provide candidate-content
comparison separately.

## Error handling

All lane references are zero-based and are validated before any write. A tool
rejects audio writes to a missing file, an invalid lane, invalid clip length,
or a non-MIDI target for MIDI creation. Audio imports use
`resources.importIntoProject()` before the lane clip is created, matching the
existing project-managed asset policy.

Each create/write/import response includes the resolved track index, lane
index, lane name, clip name, and beat range. Failed validation leaves the Set
unchanged.

## Testing

Tests will verify:

- Lane presentation is compact and handles empty lanes.
- Lane index validation rejects invalid values before mutation.
- MIDI writes create the clip then apply normalized notes, snapping and swing.
- Audio import uses the managed project path and passes the requested timing.
- Selection guard accepts/rejects the new tool names consistently with other
  arrangement-track tools.
- Existing dispatcher behavior and the full production build remain valid.

## Out of scope

This feature does not add automatic comping, individual lane solo/mute,
rendered comparison, audio warp editing, Rack/Chain control, MIDI probability,
or Master/Return tooling.
