# Context Menu Scope De-duplication

## Problem

A right-click on an Arrangement MIDI or Audio Clip matches both its direct clip
scope (`MidiClip` or `AudioClip`) and its track arrangement-selection scope
(`MidiTrack.ArrangementSelection` or `AudioTrack.ArrangementSelection`). Live
renders one identical `AIbleton: Open` action for each matching registration.
This is scope overlap, not a duplicate extension installation or lifecycle
registration failure.

## Decision

Keep direct object scopes and remove the two ArrangementSelection menu scopes:

- Keep `MidiClip` and `AudioClip` for exact clip focus.
- Remove `MidiTrack.ArrangementSelection` and
  `AudioTrack.ArrangementSelection` from the registered menu scopes.

The resulting Arrangement Clip context menu has exactly one AIbleton action
and preserves the most precise target object for clip-level editing.

## Consequence

The existing parsing and selection-boundary implementation remains in the
codebase, but users cannot invoke it through an ArrangementSelection right
click action in this release. Session Clip Slot selection remains unchanged.

## Implementation and Testing

Only the scope registration list in `src/extension.ts` changes. Add a focused
testable scope-list helper or assertion so the two arrangement-selection scope
strings cannot be reintroduced accidentally. Run the complete test suite and
production build.

## Non-Goals

- Do not change command, modal, server, lifecycle, or selection-resolution
  behavior.
- Do not rename menu actions to hide overlap; only one action should exist.
- Do not remove Session `ClipSlotSelection` in this change.
