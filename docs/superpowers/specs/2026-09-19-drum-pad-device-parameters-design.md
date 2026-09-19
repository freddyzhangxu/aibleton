# Drum Pad Device Parameter Control

## Goal

Expose read and write access to parameters of built-in devices inside a Drum
Rack pad chain. This completes the existing pad workflow: users can inspect,
insert, duplicate, delete, sample-load, and now configure pad effects and
instruments without leaving AIbleton.

## Tools

- `get_drum_pad_device_parameters`: resolve track, Rack, pad note, and chain
  device; return current value, min/max, factory default, and enum item names.
  An optional case-insensitive `filter` narrows large parameter lists.
- `set_drum_pad_device_parameter`: resolve one parameter by numeric index or
  exact/unique partial name; accept numeric values, enum names, and `default`.
- `set_drum_pad_device_parameters`: accept up to 24 parameter/value pairs and
  apply them independently in parallel. Successful items remain applied when
  another item fails; the result separates `applied` and `failed` rows.

All tools use the existing `track → Rack → pad_note → chain device` selectors.
The read tool is read-only. Write tools are ordinary Set mutations subject to
the existing confirmation and selected-track boundary; they do not require
deletion authorization.

## Reuse

The dispatcher reuses `drumRackAt`, `drumPadAt`, and `chainDeviceAt` for
location; it reuses `paramAt` and the existing value parser/clamp/default/
quantized-item behavior for parameter application. No pad-specific parameter
interpretation is introduced.

## Error Handling

Invalid track/Rack/pad/device/parameter references fail with current helpful
resolver errors. A selected non-parameter device is rejected before mutation.
For batch writes, each parameter has its own error boundary; one malformed
entry never cancels valid entries.

## Testing

Add focused tests for filtered reads, enum/default application, clamping,
partial batch failure, and selected-track enforcement. Run the full suite,
TypeScript validation, and production build.

## Non-Goals

- No parameter automation, modulation, or mapping.
- No third-party plug-in insertion support.
- No rollback of a partially successful batch.
- No new context-menu scopes.
