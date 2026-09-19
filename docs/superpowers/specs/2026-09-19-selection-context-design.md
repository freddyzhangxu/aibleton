# Selection Context Design

## Scope

Add transient Ableton Live selection context to AIbleton. This is the first
item in the API-utilization roadmap: Arrangement Selection and Clip Slot
Selection become an AI operation boundary.

## User-facing rule

When a user opens AIbleton from a Live selection, that selection is the
default scope for analysis, arrangement, and edits. The agent must stay within
it unless the current user message explicitly requests a global operation,
such as "整首歌", "全曲", "全局", or "whole song".

The selection is a soft boundary for conversational intent and a hard
boundary for mutating tool calls that have an unambiguous timeline or
track/scene target. Read-only song-wide inspection remains available where it
is needed to understand the selected material.

## Context capture

`extension.ts` will register two additional menu scopes using the existing
`ai-assistant.open` command:

- `AudioTrack.ArrangementSelection` and `MidiTrack.ArrangementSelection`:
  capture the selected lane handles and the half-open beat range
  `[time_selection_start, time_selection_end)`.
- `ClipSlotSelection`: capture the selected clip-slot handles and resolve each
  one to a stable `{ trackIndex, trackName, sceneIndex }` coordinate.

The existing single-object right-click focus remains unchanged and may coexist
with a selection. Selections have no UI storage and are never written to chat
history or settings.

## Selection context module

Extend `setcontext.ts` rather than create a second global context mechanism.
It will own a discriminated transient selection value and expose a setter for
the command payload. On every user turn `updateSetContext()` will:

1. Confirm that its recorded Live Set handle matches the currently open Set.
2. Re-resolve selection handles so deleted tracks/slots are discarded.
3. Clear a selection that has become empty or invalid.
4. Append a compact, explicit selection line to `setContextPrompt()`.

The arrangement line includes selected tracks and bar/beat range; the Session
line includes the slot coordinates and, when present, clip names. It explicitly
states that the selection is the default limit and describes the global-intent
exception.

## Tool boundary enforcement

Selection parsing and validation live in a small helper module so dispatcher
and arrangement code do not duplicate policy.

- Arrangement selection constrains track-targeted mutations to one of its
  tracks, and timeline mutations to its selected beat interval.
- Session selection constrains session-slot writes/deletes to an explicitly
  selected coordinate. Track-only changes are limited to selected tracks.
- Operations with no meaningful selected coordinate (for example settings or
  artist memory) remain unaffected.
- A global-intent flag is computed from the current user text for the active
  turn only. It is never remembered in chat history. When true it bypasses
  selection checks.
- Violations fail before mutation with an actionable error that identifies the
  selected boundary and tells the agent to ask for an explicit whole-song
  instruction or operate inside it.

The first implementation will protect the direct mutation paths with clear
coordinates: arrangement placement/clearing, MIDI clip writes and edits,
audio import, session clip writes/deletes, track state/device/mixer mutations,
and track duplication/deletion. Creation of a new track or scene is not
selection-addressable and therefore is allowed, while its subsequent edits
remain bounded.

## Error handling

Malformed context-menu payloads, stale handles, selection targets not found
in regular tracks, and empty selections are treated as no selection rather
than errors that prevent opening the chat. A deleted or changed Live Set clears
both single-object focus and selection context. Tool checks run before the
first SDK mutation, including inside `arrange_song` before its clear phase.

## Testing

Unit tests will cover:

- Arrangement and Session context rendered in the system prompt.
- A selection clearing after its Live Set changes or all handles disappear.
- Selection payloads that are malformed or empty safely doing nothing.
- The global-language detector recognizing Chinese and English whole-song
  instructions but not carrying permission into later turns.
- Allowed and rejected target/range checks for arrangement and Session
  coordinates.
- An `arrange_song` rejection happening before clips are cleared or created.

## Out of scope

This item does not add take lanes, warp editing, Rack/Chain controls, MIDI
probability, Master/Return tooling, or a new web UI. Those remain subsequent
roadmap items.
