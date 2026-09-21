# Random Instrument Selection Design

## Summary

When the user asks AIbleton to create a melodic MIDI part without naming an instrument, AIbleton should select a synth/instrument from a curated random pool instead of repeatedly defaulting to Operator. The random choice is made in application code, not left to model sampling.

When the user explicitly names an instrument, that choice remains authoritative. Existing instruments are never replaced by the random-selection behavior.

## Scope

The random pool for the first version is:

```ts
["Analog", "Operator", "Wavetable", "Drift", "Meld", "Collision", "Tension"]
```

These are the Live devices in the user's available device list that can reasonably serve melodic or bass-oriented roles. Drum devices, racks, external hardware interfaces, and sample-only devices are excluded from this random pool.

The behavior applies only to inserting an instrument on a new or otherwise empty melodic MIDI track. It does not alter explicit device replacement, drum-kit loading, sample loading, or existing instrument chains.

## Recommended approach

Use a pseudo-device value, `random`, in the existing `insert_device` tool. The system prompt tells the model to pass `device_name: "random"` when the user has not specified an instrument. The dispatcher resolves that value with `Math.random()` against the curated pool, inserts the selected Live device, and returns the selected name in the tool result.

This keeps the random decision in deterministic application code, avoids a second model/tool round trip, and preserves the existing explicit `device_name` path.

## Data flow

1. User asks for a melodic or bass part without naming a device.
2. The model calls `insert_device` with `device_name: "random"`.
3. The dispatcher chooses one pool entry and calls Live's `insertDevice` with that concrete name.
4. The dispatcher returns both the inserted device and the resolved name.
5. The model reports the actual device selected to the user.

For a request such as “加载 Analog” or “用 Wavetable 做 Bass”, the model passes the explicit name and no random selection occurs.

## Prompt and tool contract changes

- Replace the current Operator-first melodic-instrument guidance with an explicit rule: unspecified melodic/bass instruments use `random`; explicit user choices win.
- Document `random` in the `insert_device` description and list the curated pool so the model does not treat it as a Live device name.
- Keep the replacement rule unchanged: changing an existing instrument requires `replace_device` and explicit user intent.

## Error handling

- If the random selection fails to insert, return the same insertion error path as a directly named device; do not silently retry with another device.
- The tool result must expose the resolved device name only after the insertion call succeeds.
- The pool is kept in one source of truth so prompt documentation and runtime selection cannot drift silently.

## Testing

- Unit-test that random selection always returns one of the seven allowed devices.
- Unit-test boundary behavior with an injected/random-value helper so tests are not flaky.
- Test `insert_device` with `device_name: "random"` and verify the concrete name passed to Live and returned to the caller.
- Test explicit `Analog`, `Operator`, and `Wavetable` insertion remains unchanged.
- Test replacement behavior is not routed through random selection.
- Run the existing TypeScript tests and build after implementation.

## Non-goals

- No user-facing random-pool settings UI in this iteration.
- No random replacement of existing instruments.
- No automatic randomization of synth parameters or presets.
- No inclusion of Drum Rack, Impulse, DS drum devices, Instrument Rack, External Instrument, Sampler, or Simpler in the synth pool.
