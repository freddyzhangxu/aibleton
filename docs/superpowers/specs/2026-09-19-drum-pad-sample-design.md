# Drum Pad Sample Inspection and Replacement

## Goal

Let AIbleton inspect and replace the audio loaded by Simpler devices inside a
Drum Rack pad. A user can target the stable path `track → Drum Rack → MIDI
pad note → Drum Chain` without manually opening nested device chains.

## Tools

### `get_drum_pad_sample`

Resolve the requested track, Drum Rack, and pad chain using the existing
`track_index`/`track_name`, `rack_index`/`rack_name`, and `pad_note` selectors.
Return every Simpler in that chain, including its chain-device index, name,
whether a sample is loaded, and the full sample path/basename when available.
The result also identifies the Rack and pad note. It is read-only and is added
to the existing read-only tool policy.

### `replace_drum_pad_sample`

Accept `file_path` plus the same Rack/pad selectors. The file must exist and
is first copied through `resources.importIntoProject`; only the managed path is
given to `Simpler.replaceSample`.

An optional `device_index` or `device_name` selects a specific Simpler within
the pad chain. When no selector is given, the first Simpler in the chain is
used. If no Simpler exists at all, insert a new `Simpler` at chain index zero,
then replace its sample. A supplied selector that resolves to a non-Simpler is
an error; it never causes an additional Simpler to be inserted.

The result returns the resolved track, Rack, pad note, Simpler name/device
index, managed file path, and whether a Simpler was newly inserted.

## Safety and Boundaries

`replace_drum_pad_sample` mutates the Set but does not delete content. It uses
the existing mutation confirmation flow and track-targeted selection guard; it
does not require the explicit deletion authorization. Invalid track/Rack/pad/
device/file references fail before any SDK mutation. SDK insertion and sample
replacement run in the existing transaction convention. `get_drum_pad_sample`
can run outside a current selection because it is read-only.

## Implementation Boundaries

- Reuse `drumRackAt`, `drumPadAt`, `chainDeviceAt`, and the existing project
  import/Simpler replacement patterns.
- Add tool schemas in `tools/definitions.ts`, dispatcher implementations,
  read-only policy registration, and selection-guard mutation registration.
- Add focused tests for loaded/unloaded inspection, explicit selector behavior,
  automatic Simpler creation, managed-file replacement, invalid device types,
  and selected-track enforcement.

## Non-Goals

- Do not create or remove Drum Rack chains/pads.
- Do not support non-Simpler sampler devices or third-party plug-ins.
- Do not analyze waveform contents, manipulate zones, or alter per-pad mixer
  settings.
- Do not add another context-menu scope; the existing Drum Rack and Simpler
  right-click contexts are sufficient.

## Acceptance Criteria

1. A user can enumerate every Simpler and source file on a target pad.
2. A user can replace a specified pad Simpler with a project-managed file.
3. An empty pad chain gains one Simpler at index zero and loads the file.
4. An explicit non-Simpler selector fails without adding a device.
5. Existing tests, focused tests, type checking, and production build pass.
