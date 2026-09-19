# Audio Warp Editing Design

## Scope

Add safe inspection and editing of warp state for existing Ableton Live audio
clips. The feature targets both arrangement clips and Session View slots and
does not change a clip's source file, mixer, or device chain.

## User outcome

Users can ask AIbleton to inspect an audio clip's Warp state, turn warping on
or off, and select the appropriate Live algorithm for the material. Examples:

- inspect a vocal clip's warp markers before an edit;
- switch a vocal to Complex Pro;
- put a rhythmic loop in Beats mode; or
- disable warping for a one-shot that should retain its original timing.

## Tools

Expose two provider-neutral tools:

- `get_audio_clip_warp`: returns clip identity/location, warping state,
  `warp_mode`, and read-only warp markers.
- `set_audio_clip_warp`: changes `warped` and/or `warp_mode` for the targeted
  clip and returns the applied state.

Both tools use `track_index` plus `track_name`, followed by exactly one source
coordinate: `clip_index` for an arrangement clip or `scene_index` for a
Session slot. They reject MIDI clips and an empty Session slot.

`warp_mode` uses a stable string vocabulary: `beats`, `tones`, `texture`,
`repitch`, `complex`, `complex_pro`. The dispatcher maps it to the SDK enum
and presents the enum as the same string on reads.

## Safety and selection policy

The existing selection guard applies before mutation:

- Arrangement target clips must be fully inside an active Arrangement
  selection and on a selected track.
- Session target slots must be explicitly selected under an active Session
  selection.
- A current-turn explicit whole-song/global request can bypass the boundary.

Setting a mode implicitly enables warping first; turning `warped` off without a
mode change simply disables it. Calling the tool with neither field is rejected
before mutation. Warp markers are returned only; this SDK version has no
marker-write method, so marker edits are intentionally unavailable.

## Implementation structure

A focused `tools/warp.ts` helper resolves a clip through the existing track
resolver, confirms `AudioClip`, translates mode strings/enums, and serializes
markers. The dispatcher remains a thin tool adapter. The helper also makes
the read and write paths share precise error handling.

## Testing

Tests will cover arrangement and Session target resolution, MIDI/empty-slot
rejection, round-trip mode conversion, implicit warping on mode set, explicit
warping off, malformed mode rejection, and selection-guard behavior.

## Out of scope

This item does not create/delete/move warp markers, alter start/end markers or
loop points, batch-edit clips, change audio clip gain, or introduce audio
analysis/rendering changes.
