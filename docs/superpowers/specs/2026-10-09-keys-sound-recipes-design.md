# Keys Sound Recipes — Design

## Goal

Add a Keys role with two pop-ready sound recipes: a local piano sample profile
and an Operator-based DX7-style FM profile. Route generic Keys requests to the
piano profile by default, and route explicit DX7/FM/electric-piano requests to
Operator.

## User intent and success criteria

- `keys_piano_sample` loads a suitable local piano one-shot into Simpler and
  uses Operator as its declared fallback when no sample matches.
- `keys_dx7_synth` uses Ableton Operator for an FM electric-piano sound inspired
  by DX7-style tones. It does not load a third-party or Yamaha preset.
- A generic Keys request defaults to the Piano sample profile without asking
  which Keys source to use.
- Explicit DX7, FM, electric piano, or electric/e-piano wording selects
  `keys_dx7_synth`, including when the request otherwise mentions sample use.
- A sample search checks the filename stem for piano evidence and rejects
  loop/phrase files. Parent folder names cannot make a file appear to be a
  piano sample.
- Missing piano samples use the Operator fallback and explain the fallback.
- Existing source replacement uses the approved delete-first flow. If a step
  fails after deletion, report `source_deleted`, the removed source as
  `replaced_source`, the actual `current_source`, and Live Undo guidance.
- Applying recipes remains scoped to the named/selected MIDI track and its
  primary instrument. Effects, clips, mixer state, and other tracks remain
  unchanged.

## Scope

### Included

- Add `keys` to the shared `SoundRecipe.role` union and add two recipe IDs:
  `keys_piano_sample` and `keys_dx7_synth`.
- Add prompt routing, sample evidence/search, scoped source authorization, and
  tool documentation for Keys.
- Treat a generic Keys role request as the approved Piano sample default. Keep
  DX7/FM/electric-piano descriptors ahead of that default.

### Excluded

- Additional Rhodes/Clavinet/organ/strings profiles.
- A separate Keys tool, Rack construction, multi-layer instrument, or preset
  file loading.
- Automatic waveform analysis or sample selection by MIDI note range.
- Changes to existing Bass, Pad, Pluck, or Lead recipe behavior.
- Note generation, chord voicing, rhythm, or arrangement changes.

## Recipe catalog

### `keys_piano_sample`

- `role: "keys"`, `source: "sample"`, `samplePlayback: "one_shot"`.
- Queries, in order: `grand piano`, `acoustic piano`, `piano keys`.
- Filename evidence group: one of `piano`, `grand piano`, `acoustic piano`, or
  `upright piano` must appear in the filename stem.
- Use a short piano-style Simpler envelope: `(attack, decay, sustain, release)`
  normalized targets `(0.001, 0.36, 0.45, 0.18)`.
- `fallbackInstrument: "Operator"`; use the same Operator target array as
  `keys_dx7_synth` for the fallback. If no piano sample matches, apply Operator
  and say that the sample search fell back to an FM Keys approximation.

### `keys_dx7_synth`

- `role: "keys"`, `source: "synth"`, `instrument: "Operator"`,
  `fallbackInstrument: "Operator"`, and `sampleQueries: []`.
- Reuse exact Operator aliases already used by the existing Pluck recipe:
  `Ae Attack`, `Ae Decay`, `Ae Sustain`, `Ae Release`, `B Coarse`, `B Level`,
  and `Filter Frequency`, including the existing exact alias variants for
  oscillator B and filter frequency.
- Use normalized targets: `Ae Attack 0.0002`, `Ae Decay 0.42`,
  `Ae Sustain 0.28`, `Ae Release 0.12`, `B Coarse 0.18`, `B Level 0.28`, and
  `Filter Frequency 0.7`.
- Missing or ambiguous aliases are reported as skipped. Do not guess other
  Operator controls.

## Prompt routing

1. Explicit `DX7`, `FM`, `electric piano`, `electric`, or `e-piano` →
   `keys_dx7_synth`.
2. Explicit piano/grand/acoustic-piano wording → `keys_piano_sample`.
3. Generic `Keys` or pop Keys with no explicit electric/FM descriptor →
   `keys_piano_sample`, even when the user did not say “sample”.
4. If the user explicitly forbids samples without naming a different Keys
   source, ask which non-sampled Keys sound they want. An explicit DX7/FM or
   electric-piano descriptor selects Operator.

Never replace an explicitly named instrument implicitly. Apply recipes only to
the named or selected MIDI track and preserve effects and all other Set
content.

## Authorization and failure behavior

- Recognize `keys`, `keyboard`, `piano`, `DX7`, and electric-piano terms as
  Keys recipe intent. A source change still requires an action plus a Keys
  recipe/timbre request and grants only `sound_source`, never generic device
  deletion.
- A negated sample request cannot authorize the Piano sample source. If the
  same request explicitly names DX7/FM or electric piano, it can still
  authorize the Operator profile.
- Search only local samples. If no match is found, report the Operator
  fallback. Preserve the existing guitar/kalimba evidence rules.
- On source insertion or parameter failure after deleting an existing primary
  instrument, report the actual state and Live Undo guidance. Do not claim the
  previous source remains or retry automatically.

## Verification

- Run `cd AIbleton && npm run build` and `git diff --check` after
  implementation.
- Do not add or run automated tests unless the user explicitly asks for
  tests or implementation verification.

## Known quality limit

Piano sample matching is based on filename evidence and one sample is
transposed across notes. DX7-style sound uses Operator controls and is an
approximation, not a loaded DX7 preset. Final range, velocity, and timbre
quality require auditioning in Live.
