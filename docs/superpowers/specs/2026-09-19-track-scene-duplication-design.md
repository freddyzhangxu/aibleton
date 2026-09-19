# Track and Scene duplication

## Goal

Expose Live's native Track and Scene duplication through clear, focused tools.

## Tools

- `duplicate_track(track_index, track_name?)`: resolve the source with the
  existing stale-index guard; duplicate it and return the duplicate name and
  its current index.
- `duplicate_scene(index)`: duplicate the current zero-based Scene and return
  its name and index.

The SDK inserts each duplicate immediately after its source. Do not rename the
duplicate automatically; Live's default name remains intact. Both tools are
Set mutations and use existing confirmation and verification flows.

## Verification

- Test index calculation after insertion and name-based Track re-resolution.
- Run type checks/tests and verify both operations manually in Live.
