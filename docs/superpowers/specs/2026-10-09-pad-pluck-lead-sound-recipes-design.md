# Pad, Pluck, and Lead Sound Recipes — Design

## Goal

Extend AIbleton's shared sound recipe workflow so Pad, Pluck, and Lead roles
can use a small set of reusable, timbre-led recipes. Preserve all current Bass
and Pluck recipes and the existing sample behavior.

## User intent and success criteria

- Pad, Pluck, and Lead sound-design requests resolve to reusable recipes rather
  than relying only on a default instrument.
- Explicit timbre descriptions take priority over genre defaults.
- When only a clear genre is given, map it to an appropriate recipe; ask one
  concise question when neither timbre nor genre/current context resolves the
  choice.
- New Pad and Lead recipes use built-in Live synthesizers and exact parameter
  aliases. Unsupported controls are reported as skipped; no parameters are
  guessed.
- Applying a recipe remains scoped to the named/selected MIDI track and the
  track's primary instrument. Effects, clips, mixer settings, other tracks,
  and Rack contents remain untouched.
- Successful changes report the applied and skipped controls and preserve the
  existing listen hint. AIbleton does not claim to have listened through the
  instrument device chain.

## Current state to preserve

- The eleven Bass recipes and their behavior stay unchanged.
- Keep the three synth Pluck recipes: `pluck_bright`, `pluck_warm`, and
  `pluck_bell`.
- Keep the sampled Pluck recipes `pluck_guitar` and `pluck_kalimba`, including
  their sample search, suitability checks, and synth fallback behavior.
- Keep current source-change authorization, selection scope, YOLO behavior,
  exact parameter matching, Undo recovery messaging, and verification flow.

## Scope

### Included

- Generalize `SoundRecipe.role` to `bass | pad | pluck | lead`.
- Add six synth-only recipes:
  - `pad_warm`: warm, soft Pad.
  - `pad_airy`: airy, bright Pad.
  - `pad_dark`: dark, cinematic Pad.
  - `lead_clean`: clear, rounded Lead.
  - `lead_analog`: warm, analog-style Lead.
  - `lead_aggressive`: bright, forceful Lead.
- Reuse `apply_sound_recipe` for all roles, keeping its track resolution,
  authorization, preflight, exact alias matching, result, and verification
  behavior shared.
- Extend prompt routing and explicit source-replacement authorization for Pad
  and Lead recipe requests.
- Use the recipe workflow when the user asks to design a Pad/Lead sound or asks
  for a new Pad/Lead part whose musical context identifies a profile. Preserve
  existing stable instrument defaults when the user asks only to insert a
  generic instrument without a sound-design intent.

### Excluded

- New Pad or Lead sample recipes, new sample search behavior, or changes to
  sampled Pluck recipes. Sample workflows can be designed separately after
  this work is complete.
- Third-party plugins or preset-file loading.
- MIDI note, rhythm, articulation, or arrangement changes beyond the user's
  separate content request.
- New confirmation UI or changes to existing Allow/YOLO behavior.
- Automatic rendering/listening analysis through a MIDI track's full device
  chain.

## Recipe design

Extend the shared `SOUND_RECIPES` catalog and `SoundRecipeId` union while
preserving existing IDs. Each new recipe has `role: "pad"` or `role: "lead"`,
`source: "synth"`, a fixed built-in instrument, a role-specific label and
genre/timbre terms, an empty `sampleQueries`, and normalized parameter targets
for that instrument.

Use these fixed built-in instrument assignments for the first version:

| Recipe | Instrument | Main controls |
|---|---|---|
| `pad_warm` | Drift | Amp envelope, low-pass cutoff/resonance |
| `pad_airy` | Wavetable | Amp envelope, filter cutoff/resonance |
| `pad_dark` | Operator | Amp envelope, oscillator B character/level, filter cutoff |
| `lead_clean` | Drift | Amp envelope, low-pass cutoff/resonance |
| `lead_analog` | Drift | Amp envelope, low-pass cutoff/resonance, with a warmer/more rounded balance |
| `lead_aggressive` | Wavetable | Short amp envelope, brighter filter, controlled resonance |

Reuse only parameter aliases already represented by the current Pluck recipe
targets for those devices, adding profile-specific normalized values. This
keeps the first version on known device parameter families. Parameter aliases
must match exactly after the existing normalization; a missing or duplicate
match is skipped and reported.

Do not silently fall back to a different sound source for Pad or Lead if
insertion fails; return the existing insertion error and Undo guidance when
applicable.

## Execution and authorization

- Keep the MIDI-only constraint and primary-source preflight. Refuse Rack,
  unknown, or multiple primary instruments before mutation.
- Reuse exact current track name/index resolution, current selection scope,
  and `sound_source` authorization. Extend the recipe-intent parser to
  recognize Pad and Lead roles and the six new recipe IDs; this authorization
  remains separate from generic device deletion authorization.
- Replacing a primary instrument is allowed only when the current request
  explicitly asks to apply or create the relevant Pad/Lead sound recipe on the
  named/selected track. YOLO continues to use the existing bypass behavior.
- Only change the primary instrument and its recipe targets. Preserve the
  rest of the device chain and Set.
- Keep sampled Pluck search and loading restricted to its existing recipes.
  Pad and Lead recipes never invoke sample search.

## Prompt routing

For Pluck, retain current routing: explicit sampled instruments route to
`pluck_guitar` or `pluck_kalimba`; otherwise explicit timbre takes priority
(`pluck_bright`, `pluck_warm`, `pluck_bell`), followed by the existing
House/Techno, Jazz/Bossa, and Pop/Cinematic genre mappings.

For Pad, route explicit descriptors first:

- warm/soft/mellow → `pad_warm`
- airy/shimmering/bright → `pad_airy`
- dark/cinematic/drone → `pad_dark`

Genre fallback when no timbre is specified:

- Ambient → `pad_airy`
- Cinematic → `pad_dark`
- House/Techno → `pad_warm`

For Lead, route explicit descriptors first:

- clean/clear/rounded → `lead_clean`
- analog/warm/vintage → `lead_analog`
- aggressive/bright/punchy → `lead_aggressive`

Genre fallback when no timbre is specified:

- Pop → `lead_clean`
- Funk/Disco → `lead_analog`
- House/Techno → `lead_aggressive`

If the current request, relevant artist memory, and clearly identifiable
current musical context do not resolve the profile, ask one short question
instead of choosing silently. Preserve explicit instrument names and never
replace an existing instrument implicitly.

## Failure behavior

- Unknown recipe ID: return all supported recipe IDs without changing the
  Set.
- Non-MIDI track, Rack, unknown device, or ambiguous primary source: return a
  precise error and do not mutate.
- Missing/duplicate aliases: report each skipped control.
- Instrument insertion/replacement failure: retain existing failure and Undo
  recovery behavior; do not guess an alternate instrument.
- Successful changes report role, recipe, target track, source instrument,
  applied/skipped controls, and the existing listen hint.

## Verification

- Run `cd AIbleton && npm run build` and `git diff --check` after implementation.
- Do not add or run automated tests unless the user explicitly asks for
  tests or implementation verification.

## Known quality limit

AIbleton can verify recipe parameter writes but cannot automatically analyze
the final sound of the instrument through its complete device chain. Final
Pad, Pluck, and Lead quality still requires auditioning in Live.
