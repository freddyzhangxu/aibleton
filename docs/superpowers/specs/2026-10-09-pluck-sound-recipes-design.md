# Pluck Sound Recipes — Design

## Goal

Extend AIbleton's existing sound recipe workflow from Bass-only recipes to
reusable synthesizer Pluck recipes. Keep the current Bass recipe IDs and
behavior intact while making the shared catalog, tool schema, prompts, and
results role-aware.

## User intent and success criteria

- A request for a Pluck sound selects one of three distinct synth profiles:
  short/bright, warm/soft, or bell-like/metallic.
- Use Wavetable for short/bright, Drift for warm/soft, and Operator for
  bell-like/metallic as the initial Live-native mappings.
- Explicit timbre words in the current request take priority over broad genre
  defaults.
- If the request gives only a clear music style, map House/Techno to
  short/bright, Jazz/Bossa to warm/soft, and Pop/Cinematic to bell-like. If
  neither a timbre nor a clear style is available, ask one short question.
- Match parameter controls only by exact normalized aliases from the recipe
  catalog. Missing controls are reported as skipped; no parameter guesses are
  made.
- Apply Pluck recipes only to MIDI tracks and preserve all clips, mixer state,
  effects, other tracks, and nested Rack contents.
- Normal mode uses the existing Allow flow. YOLO mode applies the scoped
  recipe without an additional confirmation prompt.
- Tell the user to audition the result in Live. Do not claim AIbleton has
  listened to a MIDI instrument through its device chain.

## Scope

### Included

- Three new Pluck recipes:
  - `pluck_bright`: short, bright synth Pluck using Wavetable.
  - `pluck_warm`: warm, soft synth Pluck using Drift.
  - `pluck_bell`: bell-like or metallic synth Pluck using Operator.
- Generalize the recipe ID/type and catalog from `BassRecipeId` and
  `BASS_SOUND_RECIPES` to role-aware `SoundRecipeId` and `SOUND_RECIPES`;
  preserve all existing Bass recipe IDs and recipe content.
- Generalize `apply_sound_recipe` descriptions, validation errors, and
  verification labels so the same tool can apply either Bass or Pluck recipes.
- Add explicit Pluck source-change authorization for a direct Pluck recipe
  request, scoped to the named/selected track and only its primary instrument.
- Update the system prompt to map explicit sound descriptors and music styles
  to the three Pluck recipes.

### Excluded

- Guitar, kalimba, piano, or other sampled Pluck recipes.
- New rhythm, note generation, arpeggiation, or MIDI articulation behavior.
- Third-party plug-in or preset-file loading.
- Automatic rendering/listening analysis of the instrument device chain.
- New confirmation UI or a second confirmation in YOLO mode.

## Recipe and tool design

### Shared recipe model

Each recipe has a `role` (`bass` or `pluck`), stable `id`, display label,
genre/timbre terms, source strategy, target Live instrument, and device-specific
parameter targets. Bass entries remain unchanged apart from adding
`role: "bass"`; the Pluck entries use `role: "pluck"` and synth sources.

The `apply_sound_recipe` input keeps `track_index`, `track_name`, and
`recipe_id`, with the full `SoundRecipeId` union. `source_preference` remains
optional and applies only to the existing contextual `pop_bass` recipe.

### Pluck parameters

Pluck targets use exact aliases for each chosen device's amp envelope, filter
brightness, and, where relevant, oscillator/FM character. A device changes
only controls it exposes under an exact alias. The existing normalized-value
mapping and reported min/max range handling remain in place. If an alias is
missing or duplicated, skip it and include the target and reason in the
result.

### Source and authorization behavior

The preflight accepts an empty MIDI track or one identifiable primary built-in
instrument. It refuses `Instrument Rack`, `Drum Rack`, unknown devices, and
multiple primary instruments before mutation. If applying a named Pluck
recipe requires changing the primary instrument on an existing named/selected
track, the current request must clearly ask for that Pluck recipe. The recipe
source authorization remains distinct from generic device deletion
authorization and cannot authorize deleting unrelated devices.

An empty MIDI track receives the recipe's specified built-in instrument.
An already-compatible instrument is reused. A source change follows the
existing delete-first replacement and Undo behavior, while preserving the
track's effects and all other Set content.

### Prompt routing

The prompt lists all recipe IDs. Explicit sound descriptors take priority:
bright/short/punchy selects `pluck_bright`, warm/soft/mellow selects
`pluck_warm`, and bell/metallic/FM selects `pluck_bell`. When only a clear
genre is stated, route House/Techno to `pluck_bright`, Jazz/Bossa to
`pluck_warm`, and Pop/Cinematic to `pluck_bell`. When the current request,
relevant artist memory, and current musical context do not resolve the style,
ask the user rather than choosing silently.

## Failure behavior

- Unknown recipe ID: return all supported recipe IDs without changing the Set.
- Non-MIDI track, Rack, unknown device, or ambiguous source: return a precise
  error and do not mutate.
- Exact parameter alias missing or duplicated: report the skipped control.
- Device insertion/replacement failure: retain the existing Undo recovery
  message and report any partial source change accurately.
- Successful changes return applied/skipped controls, source device, and a
  listen hint for the target track.

## Verification

- Run `cd AIbleton && npm run build` and `git diff --check` after implementation.
- Do not add or run automated tests unless the user explicitly asks for tests
  or implementation verification; this follows the current workspace
  instruction.

## Known quality limit

AIbleton cannot currently analyze the final sound of a MIDI instrument through
its complete device chain. Exact parameter writes can be verified, but final
Pluck quality still requires an audition in Live.
