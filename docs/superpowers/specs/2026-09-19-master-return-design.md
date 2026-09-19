# Master and Return Control Design

## Scope

Expose Return Track mixer control and safe Master-chain inspection/parameter
control without treating either as a regular numbered track.

## Tools

- `get_return_track_mixer` / `set_return_track_mixer`: address a Return Track
  by zero-based return index; read or set volume, pan, and sends.
- `get_master_chain`: return Master mixer values and the device-chain names.
- `get_master_device_parameters`: inspect a Master device by index/name.
- `set_master_device_parameter`: set one existing Master device parameter.

Master device insertion/deletion is out of scope. Existing parameter lookup,
clamping, and value-name handling are reused.

## Protection

Return changes follow ordinary mutation confirmation and selection rules do not
block them because Return Tracks have no regular-track selection coordinate.
Master parameter writes require an explicit current-turn Master/mastering
intent (for example “调 Master”, “mastering”, “master bus”); generic mixing
requests cannot modify it. The tool reads the current device value before a
write is suggested in prompts, and the dispatcher repeats the intent check.

## Testing

Tests will cover return-index validation, Master-chain presentation, parameter
lookup/clamping, explicit-master-intent rejection, and full build regression.

## Out of scope

No Master device insertion/deletion/duplication, Return creation/deletion,
sidechain routing, automation, or loudness-target mastering is included.
