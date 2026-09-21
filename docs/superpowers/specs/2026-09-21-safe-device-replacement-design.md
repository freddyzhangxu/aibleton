# Safe Built-In Device Replacement Design

## Problem

`insert_device` always appends a device to the end of a track chain. Replacing
Track 1's `Operator` with `Analog` therefore attempts `Operator → Analog`.
The Live Extension SDK rejects that operation in the observed Set, even though
the same `Analog` device can be inserted into an empty MIDI track.

The existing assistant can delete an explicitly named device and can insert a
device, but it has no atomic replacement operation or way to choose the
insertion position. Deleting first is risky: a generic SDK insertion failure
would leave the user without the original device.

## Scope

- Replace an explicitly named built-in Live device with another built-in device
  on the same regular track.
- Preserve clips, MIDI notes, arrangement, mixer state, and all unmentioned
  devices.
- Default to a non-destructive path.
- Offer a destructive delete-first fallback only after explicit user approval.
- Do not support third-party plug-ins, racks, track replacement, or sample
  replacement; existing dedicated sample tools continue to cover those cases.

## Chosen Design

### `replace_device`

Add a `replace_device` mutation tool with:

- `track_index` and `track_name` to resolve the current track safely;
- `source_device_index` or `source_device_name` to identify the named device
  being replaced;
- `replacement_device_name` for the built-in Live device to add;
- `allow_delete_first`, defaulting to `false`.

The normal operation is:

1. Resolve and retain the source device and its current index.
2. Insert the replacement at that exact index, placing it before the source
   instead of appending it to the chain.
3. Re-read the device chain and verify that the replacement occupies the
   expected position and that the original source still exists immediately
   after it.
4. Delete only the retained source device.
5. Re-read the chain and return the replacement, removed source, fresh track
   index, and verification status.

If step 2 fails, the tool returns a structured `replacement_not_applied`
result and leaves the source untouched. The assistant must tell the user that
Live rejected the safe insertion and ask whether a destructive fallback is
acceptable.

### Explicit destructive fallback

When `allow_delete_first: true` is present and the current user message
explicitly authorizes replacing the named source device, the tool may:

1. Delete the source device.
2. Insert the replacement at the vacated index.
3. Re-read and verify the replacement.

If the insertion fails after deletion, the tool returns a failure that says
the source was removed and directs the user to Live Undo. It never deletes a
second device and never retries insertion automatically.

## Authorization and Verification

`replace_device` is treated as a device-deleting tool for both the runtime and
dispatcher defense-in-depth guards. The existing direct named-device
replacement grammar supplies authorization; vague requests remain refused.

Postcondition verification confirms the replacement device name and absence of
the source device. The tool's own chain re-reads verify the intermediate safe
insertion before deletion, which is necessary because generic SDK errors carry
no diagnostic detail.

## Tests

- Safe path: inserts at the source index, verifies both devices, then deletes
  only the source.
- Safe insertion failure: preserves the source and returns a structured,
  non-destructive outcome.
- Delete-first path: requires explicit authorization and verifies the final
  chain.
- Delete-first insertion failure: records the source deletion and returns an
  explicit Live Undo recovery instruction.
- Authorization: a vague request cannot invoke `replace_device`.
- Tool definition and prompt tests: the model learns to use replacement rather
  than append a second instrument to a track.
