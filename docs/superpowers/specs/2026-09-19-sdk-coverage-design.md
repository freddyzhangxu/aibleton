# SDK Coverage: Simpler and Drum Rack Completion

## Goal

Expose the remaining useful Ableton Extensions SDK beta-1 capabilities without
adding speculative workflows: object-context entry points for Drum Racks and
Simplers, read-only inspection of a Simpler's loaded sample, and safe deletion
of a device inside a Drum Rack pad chain.

## Scope

### Context-menu entry points

Register `DrumRack` and `Simpler` in the extension's existing `Open` context
menu action. Do not register the `Sample` scope: the user can already reach a
sample through its owning Simpler, and the host's direct Sample-menu support is
not needed for this workflow.

When the command resolves its right-click handle, extend the transient prompt
context with:

- Drum Rack name, owning track (when resolvable), number of pads/chains, and a
  compact list of the first few receiving MIDI notes.
- Simpler name, owning track (when resolvable), and either its loaded sample
  filename or an explicit `no sample loaded` state.

The descriptions must be read fresh from the handle each turn, preserve the
existing stale/deleted-object behavior, and never persist to chat history.

### `get_simpler_sample`

Add a read-only tool that locates a Simpler on a regular track by optional
`device_index` or `device_name`; if neither is supplied, it uses the first
Simpler on that track. It returns the resolved track index/name, Simpler name
and index, plus either the complete managed sample path and basename or
`loaded: false`.

The tool rejects a non-Simpler device reference, an absent Simpler, and invalid
track/device references with the same helpful resolution errors used by current
device tools. It does not import, replace, or otherwise mutate a sample.

### `delete_drum_pad_device`

Add a mutating tool that resolves a Drum Rack, pad chain, and a chain device by
the existing pad-device selector. It calls `Chain.deleteDevice` inside the
existing SDK transaction boundary, then returns the deleted device identity,
the pad identity, and the standard Live Undo guidance.

It belongs to the existing `device` deletion class. It must only run when the
current user message explicitly authorizes deletion of a device/effect/plugin;
generic cleanup wording continues to fail closed. It also participates in the
selection guard as a track-targeted mutation.

## Deliberate Non-Goals

- Do not add `Commands.executeCommand`; no internal command-to-command call is
  required.
- Do not add a separate `Sample` context-menu scope.
- Do not wire `Environment.tempDirectory` into an artificial flow. Existing
  audio import is intentionally project-managed, and pre-FX rendering already
  returns an SDK-owned temporary path. The dormant helper remains available for
  a future workflow that actually creates scratch files.
- Do not add device deletion for entire Drum Rack chains/pads; beta-1 exposes
  deletion of devices within a chain, not chain deletion.

## Files and Boundaries

| Area | Change |
| --- | --- |
| `src/extension.ts` | Register the two new context-menu scopes. |
| `src/setcontext.ts` | Describe `DrumRack` and `Simpler` focus objects. |
| `src/tools/drum-rack.ts` | Share a chain-device resolver if necessary. |
| `src/tools/definitions.ts` | Publish the two new tool schemas/descriptions. |
| `src/tools/dispatcher.ts` | Implement the read-only query and authorized chain-device deletion. |
| `src/chat/deleteauth.ts` | Map the new delete tool to the existing `device` class. |
| `src/selectionguard.ts` | Mark chain-device deletion as a track-targeted mutation. |
| tests | Add focused behavior and authorization coverage. |

## Error Handling and Safety

All handle-based context inspection fails by clearing its transient focus, as
it does today. Read-only sample inspection returns an explicit unloaded state;
it never treats a missing `Simpler.sample` as an error. Deletion runs only after
the central authorization guard, resolves the target before mutation, executes
one SDK call in a transaction, and relies on Live Undo for recovery.

## Acceptance Criteria

1. Right-clicking a Drum Rack or Simpler opens AIbleton and injects accurate,
   fresh context for that object.
2. `get_simpler_sample` distinguishes loaded and unloaded Simplers without
   altering the Set.
3. `delete_drum_pad_device` deletes the selected pad-chain device only when
   the current message explicitly authorizes device deletion.
4. It is refused for broad cleanup language and blocked outside a current
   selected track/slot boundary.
5. Existing tests, added focused tests, TypeScript type checking, and the
   production build all pass.
