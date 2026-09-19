# MIDI Expression Design

## Scope

Expose Ableton Live's per-note MIDI expression fields through AIbleton's
existing MIDI-writing tools. No randomization or new humanization algorithm is
introduced: the model supplies explicit values, and omitted fields preserve the
current behavior.

## User outcome

AIbleton can write deliberate performance detail into new or existing clips:

- low-probability ghost notes and fills;
- small velocity variation where a user requests less mechanical dynamics;
- release velocity for instruments that respond to note-off force; and
- muted notes retained in the clip as editable alternates.

This works for arrangement MIDI clips, Session clips, and non-destructive Take
Lane MIDI candidates.

## API surface

Extend the note item schema for `write_midi_clip`, `write_session_clip`,
`set_clip_notes`, and `write_take_midi_clip` with optional fields:

- `probability`: decimal probability from 0 through 1;
- `velocity_deviation`: signed MIDI velocity deviation from -127 through 127;
- `release_velocity`: MIDI release velocity from 0 through 127; and
- `muted`: boolean note mute flag.

Tool descriptions will state that the fields are optional. Existing prompts
and callers sending only pitch/start/duration/velocity produce the same
`NoteDescription` payload as before.

## Parsing and serialization

`parseNotes()` remains the single input boundary. It will validate each new
field only when present, map snake_case tool arguments to the SDK's camelCase
properties, and omit unspecified values instead of manufacturing defaults.

`get_clip_notes` and analysis snapshots will expose the fields when Live has a
value. This makes a subsequent edit round-trip existing expression data rather
than silently losing it. The compact music-state analysis continues to use the
audible-note interpretation already used for muted notes; it does not invent a
new probability-aware playback model.

## Safety and compatibility

Values outside their documented ranges fail before a clip is created or
overwritten. Boolean mute accepts only booleans. This feature inherits all
existing track, selection, confirmation, goal, snapping, and swing behavior.
Swing runs after note parsing and preserves every expression property while it
changes timing.

No random seed, global humanize control, clip-wide probability, or automatic
velocity jitter is included. The feature is deterministic and needs no new
provider behavior.

## Testing

Tests will cover:

- legacy note input retaining the exact old shape;
- valid expression fields mapping to the SDK property names;
- boundary values and invalid probability/velocity inputs;
- snapping and swing retaining expression fields; and
- get/set note round-trip preserving optional expression values.

## Out of scope

This item does not alter audio clips, warp settings, MIDI CC, MPE,
probability-aware analysis, random humanization, or Take Lane comping.
