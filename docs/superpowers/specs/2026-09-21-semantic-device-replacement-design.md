# Semantic device replacement

## Problem

Replacing an existing Live instrument with a sample currently produces two
avoidable failures:

- The model is told that deletion requires the user to use a delete verb, so it
  treats an explicit request to replace an `Operator` as insufficient.
- Even if the model elects to call `delete_device`, the runtime independently
  derives delete permission from the raw user message and refuses the call.

The model also sometimes writes a user-specified continuous bar range such as
`bars 1-16` into a goal criterion. Goal criteria accept only exact section
names returned by `analyze_song`; a range may span several sections and is not
necessarily a valid section name.

## Product decision

An explicit request to replace a named device or instrument with another sound
source is an explicit authorization to delete that source device. It executes
without an extra confirmation, just as an explicit delete request does today.

Examples that authorize device deletion:

- `Replace the Operator device on Track 1 with a piano sample.`
- `Replace the Operator devices on Track 1 and Track 2 with piano samples.`
- `把 Track 1 的 Operator 换成钢琴采样。`

Examples that do not authorize deletion:

- `Use piano samples.`
- `Make the lead a piano.`
- `Clean up the instruments.`
- `不要替换 Operator。`

The authorization remains limited to devices. It never implicitly authorizes
track, scene, clip, or Drum Rack pad-device deletion.

## Interaction and model behavior

For an authorized replacement with a local sample:

1. Read the current Set and resolve the named track and source device.
2. Search for and choose a matching local sample before deleting the source.
3. Delete only the source device named by the user on each requested track.
4. Call `load_sample`; it creates a `Simpler` itself when none exists, so the
   model must not insert a separate `Simpler` first.
5. Read the loaded Simpler sample to verify the file landed on every target.
6. Summarize the exact devices replaced and samples loaded, including a Live
   Undo reminder if a deletion landed.

If a request mentions samples but does not explicitly name a source device to
replace, the model must not delete a device. It can search for candidates or
ask which current device should be replaced.

A pure device/sample swap is an operational configuration task, not an
arrangement or composition goal. It skips `set_goal` and `set_plan` when it
does not alter MIDI, clips, mixer, tempo, key, or structure. This prevents
unrelated role/section checks from declaring a successful sample load a
failure. Multi-track swaps retain the same per-track verification.

For any task that does need a musical goal, a user bar range is edit scope only
until it has been resolved. The model must call `analyze_song` and use only
returned section names in a `section`, `a`, or `b` criterion. If a request
spans several sections (for example bars 1-16 when Live reports bars 1-8 and
bars 9-16), it must use one criterion per actual section or select a
non-section criterion; it must never invent a merged section label.

## Implementation boundaries

This is intentionally a small end-to-end change, not a UI redesign:

- `AIbleton/src/prompts.ts`: teach the model the semantic replacement rule,
  the safe `search_samples -> delete_device -> load_sample ->
  get_simpler_sample` sequence, the device-swap goal exception, and exact
  section-name handling.
- `AIbleton/src/chat/deleteauth.ts`: recognize English and Chinese replacement
  phrasing as `device` authorization only when a source device/instrument is
  named; preserve negation and broad-request refusal behavior.
- `AIbleton/src/tools/definitions.ts`: align `delete_device` tool guidance
  with the new explicit-replacement authorization so it does not contradict
  the system prompt.
- Tests: extend `deleteauth.test.ts` with English/Chinese single- and
  multi-device positives and vague/negative non-authorizations; add prompt
  assertions for the replacement and section rules.

No new tool, UI confirmation, transaction format, track creation, or change to
the existing selection guard is included. The existing Live Undo path remains
the recovery mechanism after a successful deletion.

## Acceptance checks

- An explicit English or Chinese Operator-to-piano-sample replacement authorizes
  `delete_device` in that turn.
- A vague sample request or a negated replacement does not authorize
  `delete_device`.
- The model is instructed not to insert a separate Simpler before
  `load_sample`.
- The model is instructed to verify loaded samples and to avoid `bars 1-16` as
  a goal-section name when it crosses actual sections.
- Existing explicit deletion authorization and all non-device deletion guards
  continue to behave unchanged.
