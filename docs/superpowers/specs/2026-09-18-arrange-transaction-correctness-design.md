# Arrange transaction correctness

## Goal

Make `arrange_song` comply with the Extension SDK's synchronous
`withinTransaction` contract. A failed arrangement must retain any mutations
that completed before the failure; it must not attempt a compensating rollback.

## Background

The current implementation passes an `async` callback to
`context.withinTransaction`. The SDK explicitly forbids `await` in that
callback. Creating a clip is asynchronous because its handle is returned by
the host later, and applying MIDI notes, a name, colour, or mute state depends
on that handle. Those dependent mutations cannot be legally grouped inside the
same synchronous public-SDK transaction.

## Design

Replace the single outer asynchronous transaction with an explicit sequential
execution flow:

1. If `clear_range_bars` is set, clear each track in sequence and await each
   SDK operation.
2. Create each resolved placement in sequence and await its SDK operation.
3. Immediately apply its MIDI notes or metadata once the returned clip handle
   is available.

Every individual SDK call manages its own legal transaction. This preserves
the existing resolve-before-mutate validation, source-copy behaviour, order of
operations, and partial-success semantics.

## Error handling and user-facing result

- Do not add rollback code.
- If a later clear or placement fails, propagate the error exactly as today;
  mutations that have already completed remain in the Set.
- Change the successful result's `undo` text so it accurately says that Live
  may expose the individual completed mutations as one or more undo steps; it
  must not promise a single Undo for the whole plan.

## Scope exclusions

- No changes to placement validation, dry-run output, or audio/MIDI copying.
- No new raw Host API or private-SDK access.
- No changes to the separate `load_drum_kit` transaction flow.

## Verification

- Type-check with `npm exec tsc -- --noEmit`.
- Add or update focused tests for: no `async` transaction callback, clear
  operations preceding creates, metadata being applied after clip creation,
  and failure preserving earlier mutations without issuing rollback calls.
- Run the repository test suite.
