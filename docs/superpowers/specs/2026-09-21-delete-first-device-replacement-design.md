# Delete-First Device Replacement Design

## Problem

The safe replacement path attempts to insert a new instrument before the
existing one. Live's Extension SDK rejects that operation for the observed
`Operator → Analog` replacement, even though `Analog` can be inserted on an
empty MIDI track. The safe path therefore cannot perform ordinary instrument
replacement in this Live environment.

## Scope

- Apply one consistent default to every explicitly authorized replacement of a
  named built-in device on a regular track.
- Delete only the named source device, then insert the requested built-in
  replacement at the former source index.
- Preserve all clips, MIDI, mixer state, track metadata, and unmentioned
  devices.
- Retain current-message device-replacement authorization and dispatcher
  defense-in-depth checks.
- Exclude third-party plug-ins, racks, tracks, and sample workflows.

## Chosen Design

`replace_device` becomes a delete-first operation. It no longer attempts a
second-instrument insertion and no longer accepts `allow_delete_first`.

1. Resolve the named source device and record its index and name.
2. Delete that exact device.
3. Insert the replacement device at the recorded index.
4. Re-read the device chain and verify that the replacement occupies the
   expected position and the source is absent.

On a post-deletion insertion or verification failure, the result reports
`source_deleted: true` and a Live Undo recovery instruction. It does not retry
and it does not delete any further device.

## Prompt and Tool Contract

Tool descriptions and the system prompt will state that explicit replacement
means delete-first replacement. They will no longer offer a safety preflight or
ask for `allow_delete_first` after a failed insertion. The existing direct
named-device replacement grammar remains the required authorization boundary.

## Tests

- A normal replacement deletes the source before inserting the replacement at
  the same index.
- An insertion failure after deletion reports `source_deleted` and Live Undo.
- Vague or negative requests remain unauthorized.
- Tool and prompt tests no longer describe the removed safe-insertion branch.
- Existing mutation receipts continue to reflect a delete-first replacement,
  while failed replacement results retain their recovery information.
