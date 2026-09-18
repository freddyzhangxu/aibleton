# Arrange undo messaging

## Goal

Make every user- and model-facing description of `arrange_song` match its
current SDK-compliant execution semantics.

## Background

Clip creation returns its handle asynchronously, while applying notes and
metadata requires that handle. The public Extension SDK requires synchronous
transaction callbacks, so an entire clear/create/metadata plan cannot honestly
be promised as one undo step. The implementation validates all placements
before mutation, then applies SDK mutations in sequence; a later failure leaves
earlier successful mutations intact.

## Scope

Update the following descriptions without changing runtime behaviour:

- System prompt arrangement instructions.
- `arrange_song` tool definition description.
- Chinese user guide's Live Undo guidance.

## Messaging

- Validation errors still make zero Set changes.
- Once execution starts, operations are committed step by step under SDK rules.
- A later failure preserves completed mutations; the user can use Live Undo to
  step back through them.
- Do not claim the full placement plan is a single transaction or one Undo.

## Verification

- Search model prompts, tool definitions, and user documentation for stale
  single-undo promises.
- Run `npm exec tsc -- --noEmit` and `npm test` to confirm documentation-only
  changes do not affect the build or tests.
