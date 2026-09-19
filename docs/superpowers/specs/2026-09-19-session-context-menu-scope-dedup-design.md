# Session Context Menu Scope De-duplication

## Problem

A Session View right-click on one Clip Slot matches both `ClipSlot` and
`ClipSlotSelection`. Live renders the same `AIbleton: Open` action twice.

## Decision

Keep `ClipSlot` and remove `ClipSlotSelection` from `MENU_SCOPES`. This keeps
precise single-slot focus and ensures one Open action for a Session clip.

## Consequence

Multi-slot selection context remains implemented but is no longer available
through the right-click menu. No dispatcher, command, lifecycle, or server
behavior changes.

## Verification

Update the scope-list regression test to reject `ClipSlotSelection`, then run
the complete test suite and production build.
