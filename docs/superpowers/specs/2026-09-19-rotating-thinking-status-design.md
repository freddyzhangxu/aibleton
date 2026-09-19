# Rotating Thinking Status

## Goal

Make a long-running task feel active by changing the generic thinking word
every five seconds. For example, the English status rotates from “Thinking…”
to “Pondering…” and “Considering…”, while retaining the existing background
task note.

## Scope

Only the generic `thinking` state rotates. Explicit server-reported phases such
as reading the Live Set, analyzing, generating audio, applying changes,
planning, and searching remain fixed so the UI never replaces useful progress
information with a vague synonym.

The feature is localized for every language currently supported by the UI.
It does not alter assistant chat replies, persisted history, or server status.

## Design

`ui/interface.html` will add a small, per-language list of generic-thinking
labels. The existing base `thinking` string remains the first entry and keeps
the background-task explanation. The remaining entries use equivalent short
verbs for the active language and retain that same explanation.

The client-side thinking-state controller will own one interval and an index:

1. `setThinking(true)` creates the existing thinking bubble and starts a
   five-second interval only when the server phase is absent or `thinking`.
2. On each tick, it advances the index and replaces the bubble’s text content.
3. If the server reports an explicit phase, the controller stops the interval
   and displays the existing exact phase label.
4. If the task ends, errors, the phase changes, or the window unloads, the
   controller clears the interval and resets its index.
5. A language switch while generic thinking is visible immediately re-renders
   the current rotation position using the newly selected language.

The interval is never duplicated: repeated 900 ms status polls only update
the existing bubble and leave a matching timer in place.

## Error handling and compatibility

Timer cleanup is idempotent, so a failed status request or multiple completion
paths cannot leave a stale timer trying to update a removed node. The feature
uses only standard browser timers and `textContent`, compatible with the
existing Ableton webviews.

## Verification

Manually verify a generic task remains active past five seconds, rotates at
five-second intervals, and stops immediately when a concrete phase or final
reply arrives. Also verify reopening the UI during an active task starts only
one rotation, and switching the UI language changes the next/current label
without creating another timer. Run the production build after the change.
