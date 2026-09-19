# Drum Rack Chain Control Design

## Scope

Add safe, pad-level control for existing Drum Racks. The first release targets
the explicit path `track → Drum Rack → receiving MIDI note → Drum Chain` and
does not generalize to arbitrary nested Instrument or Effect Racks.

## User outcome

AIbleton can inspect and shape individual drum pads without changing the rest
of the kit. Example tasks include lowering a kick pad, panning an open hat,
adding a Reverb after a snare's Simpler, or duplicating a pad effect for A/B
comparison.

## Tools

Expose five tools:

- `list_drum_rack_pads`: list a selected track's Drum Racks and each pad's
  receiving note, chain index, devices, volume, and pan.
- `get_drum_pad_mixer`: read one pad chain's volume, pan, and sends.
- `set_drum_pad_mixer`: set its volume, pan, and/or sends.
- `insert_drum_pad_device`: append a built-in Live device to a pad chain.
- `duplicate_drum_pad_device`: copy one existing pad-chain device immediately
  after itself.

Pad lookup accepts the receiving MIDI note and a rack selector (`rack_index`
or `rack_name`) because a track can contain multiple Drum Racks. Device lookup
uses a zero-based index or exact/unique partial name, mirroring existing track
device tooling.

Deletion is deliberately excluded from this first release. The SDK supports
it, but inserting, duplicating, and mixer control deliver the main creative
value without expanding destructive authority.

## Implementation structure

A `tools/drum-rack.ts` helper resolves the track and Rack, then resolves a
Drum Chain by receiving note. It owns compact pad presentation and uses the
existing parameter setter for clamping. The dispatcher remains a thin adapter
for SDK mutations, transactions, and tool responses.

Built-in-device restrictions remain identical to `insert_device`: third-party
plug-ins cannot be inserted through this SDK. The existing `load_drum_kit`
workflow is unchanged.

## Safety and selection policy

All mutations retain the existing active-selection boundary: their track must
be selected unless the current user explicitly requests whole-song/global
scope. Parameters are clamped to the Live-provided range. Invalid Rack, pad,
or device references fail before mutation. Device insertion and duplication
run inside Live transactions.

## Testing

Tests will cover Rack/pad resolution, compact list output, valid and invalid
pad notes, mixer parameter writes, device insertion/duplication targets,
selection guard coverage, and preservation of existing full-suite/build
behavior.

## Out of scope

This item excludes deleting pad devices, creating/removing pads, replacing a
pad sample outside the existing `load_drum_kit` path, nested non-drum Racks,
chain mute/solo, and automatic kit analysis.
