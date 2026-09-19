# Cue Point CRUD

## Goal

Let AIbleton create, rename, and delete Live Cue Points so structural section
labels can be written back into the Set.

## Tools

- `create_cue_point(bar, name)`: 1-based bar → beat conversion, create and name.
- `rename_cue_point(index, name)`: rename the current zero-based Cue Point.
- `delete_cue_point(index)`: delete the current zero-based Cue Point.

All are Set mutations and use existing confirmation/verification flows. Invalid
bars or indexes fail before mutation. Creation groups create+name where the SDK
permits; each operation is otherwise an ordinary Live undoable mutation.

## Verification

- Test bar conversion, invalid input, rename/delete indexing, and no-write
  failure paths.
- Run type checks and the test suite; manually verify in Live.
