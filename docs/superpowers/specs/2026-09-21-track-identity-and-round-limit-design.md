# Default Track Renumbering and Tool-Round Design

## Problem

When an agent inserts a track into an Ableton Live Set, Live can renumber its
automatically named tracks. For example, inserting `Bass` before two empty
audio tracks can change `3-Audio` and `4-Audio` into `4-Audio` and `5-Audio`.

The `tracks_untouched` goal criterion currently looks up every protected track
by its exact name. It therefore reports a missing track even when the original
track's audible content has not changed. The goal gate then spends extra rounds
trying to restore cosmetic names. In the observed Bass-plus-sidechain task,
that repair reached the 20-round provider limit after the second rename.

## Scope

- Preserve strict name-based checks for user-named tracks.
- Treat Live's automatic names (`<ordinal>-MIDI` and `<ordinal>-Audio`) as
  positional defaults whose numeric prefix may change after track insertion.
- Keep `tracks_untouched` focused on its documented signal: track content,
  rather than device or mixer changes.
- Raise the provider-round backstop from 20 to 22 as a small completion buffer.

## Chosen Approach

`GoalTrackMeasure` will retain each track's type. The untouched-track judge
will separate protected tracks into two groups:

1. Custom names retain the existing exact, case-insensitive name lookup. A
   missing custom name or a changed audible-note count fails the criterion.
2. Automatic names are matched in their original Set order against an
   order-preserving subsequence of after-state tracks. A match requires the
   same type, mute state, and audible-note count. This lets an inserted track
   shift `3-Audio` to `4-Audio` without treating that cosmetic renumbering as
   a content change.

The matcher consumes each after-state candidate at most once. A protected
automatic track with no compatible later-state match still fails, so deletion,
type changes, mute changes, and audible-note changes remain visible.

Ableton exposes no persistent stable track IDs in this snapshot layer. Tracks
with identical type, mute state, and note counts are indistinguishable to this
criterion, which is consistent with its existing notes-based content proxy.

## Round Limit

Set `AGENT_MAX_ROUNDS` to 22. This is deliberately a narrow increase: it
allows a final post-tool response or goal check after a legitimate repair but
does not turn the provider loop into an open-ended retry path. The independent
eight-mutation budget remains unchanged.

## Tests

Extend `goal/__tests__/evaluate.test.ts` with:

- a passing case where an inserted MIDI track shifts protected automatic audio
  names while their type, mute state, and note counts remain unchanged;
- a failing case where a shifted automatic audio track has a different audible
  note count;
- a failing case where a protected custom-named track is missing.

Also add or update the focused agent-loop test that asserts the round-backstop
value, if the suite has one. Run the affected goal and agent tests, then the
project's normal test command.
