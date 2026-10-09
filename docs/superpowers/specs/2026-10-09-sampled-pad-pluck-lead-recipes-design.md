# Sampled Pad, Pluck, and Lead Recipes — Design

## Goal

Add reusable sample-based recipes for Pad, Pluck, and Lead while keeping the
existing synth recipes and the explicit guitar/kalimba Pluck sample recipes.
Pad samples play as looped sustained textures. Pluck and Lead samples play as
pitched one-shots in Simpler.

## User intent and success criteria

- Each of Pad, Pluck, and Lead has sample recipes parallel to its existing
  timbre-led synth profiles.
- A sample recipe is chosen only when the user explicitly asks for a sample
  source. The existing synth profiles remain the default otherwise.
- Explicit timbre takes priority over genre defaults. For Pluck, an explicitly
  named guitar or kalimba sample retains its existing source-specific route.
- Sample suitability uses filename evidence for both instrument/timbre family
  and playback type. Pad accepts explicitly loop-marked files; Pluck and Lead
  sample profiles reject files marked as loops.
- A Pad recipe sets Simpler to Classic playback with Loop enabled. If the
  required controls are missing, ambiguous, or unsupported, the action refuses
  before replacing the current source.
- When a compatible sample cannot be found, the recipe may fall back to its
  declared built-in synth and must tell the user. Unsupported loop controls do
  not fall back to a synth.
- Applying a recipe remains scoped to the named/selected MIDI track and its
  primary instrument. Effects, clips, mixer state, other tracks, and Rack
  contents stay unchanged.
- Results report the selected source, playback mode, applied/skipped controls,
  and the existing listen hint. AIbleton does not claim to have listened
  through the instrument device chain.

## Current state to preserve

- Preserve all eleven Bass recipes and the six synth recipes already available
  for Pad, Pluck, and Lead.
- Preserve the existing sample Pluck recipes `pluck_guitar` and
  `pluck_kalimba`, including their IDs, sample queries, filename evidence, and
  synth fallbacks.
- Preserve current sample search ranking, resource import, track resolution,
  target scope, `sound_source` authorization, YOLO behavior, verification, and
  Undo messaging, except for the specific staged sample replacement behavior
  defined below.

## Scope

### Included

- Add nine sample recipes, with a stable `_sample` suffix:
  - Pad: `pad_warm_sample`, `pad_airy_sample`, `pad_dark_sample`.
  - Pluck: `pluck_bright_sample`, `pluck_warm_sample`, `pluck_bell_sample`.
  - Lead: `lead_clean_sample`, `lead_analog_sample`,
    `lead_aggressive_sample`.
- Add recipe metadata that declares sample playback intent (`loop` or
  `one_shot`) and grouped filename evidence. Existing sample recipes may omit
  this new metadata to preserve their matching behavior.
- Extend prompt routing, sample suitability, Simpler playback setup, and
  failure-safe sample source replacement.

### Excluded

- New Bass sample recipes or changes to Bass sample search and fallback.
- Changes to existing `pluck_guitar` or `pluck_kalimba` behavior.
- Audio analysis, transient detection, or automatic loop-point creation.
- Third-party plugins, preset loading, sample synthesis, or downloading new
  samples from online catalogs.
- MIDI notes, rhythm, articulation, or arrangement edits.
- A new confirmation UI or changes to normal/YOLO authorization semantics.

## Recipe catalog

Add these nine recipes to `SOUND_RECIPES`. All use `role` matching the prefix,
`source: "sample"`, a fixed sample query list, `samplePlayback` metadata,
sample filename evidence groups, a declared built-in synth fallback, and
targets for `Simpler` plus the fallback device.

| Recipe | Playback | Sample family | Synth fallback |
|---|---|---|---|
| `pad_warm_sample` | loop | warm, soft, mellow Pad textures | Drift (`pad_warm`) |
| `pad_airy_sample` | loop | airy, shimmering Pad textures | Wavetable (`pad_airy`) |
| `pad_dark_sample` | loop | dark, cinematic Pad textures and drones | Operator (`pad_dark`) |
| `pluck_bright_sample` | one-shot | bright plucks and mallet tones | Wavetable (`pluck_bright`) |
| `pluck_warm_sample` | one-shot | warm plucks, soft guitar, and mellow struck tones | Drift (`pluck_warm`) |
| `pluck_bell_sample` | one-shot | bell-like plucks and metallic mallets | Operator (`pluck_bell`) |
| `lead_clean_sample` | one-shot | clean, clear synth/keyboard leads | Drift (`lead_clean`) |
| `lead_analog_sample` | one-shot | warm, vintage, analog-style leads | Drift (`lead_analog`) |
| `lead_aggressive_sample` | one-shot | bright, aggressive, distorted leads | Wavetable (`lead_aggressive`) |

The existing Pluck guitar and kalimba recipes remain separate explicit source
choices. The new Pluck timbre recipes provide sample alternatives that do not
require a specific sampled instrument to be named.

### Parameter targets

- All sample recipes set the Simpler amp envelope using the exact aliases
  already used by the current sample Pluck recipes (`Amp Attack`, `Amp Decay`,
  `Amp Sustain`, and `Amp Release`, matched exactly after normalization).
- New Pad sample recipes also require exact unique Simpler controls for
  playback `Mode` (`Classic`) and `Loop` (`On`). Use only exact aliases and
  exact quantized option names exposed by Live. Missing, duplicate, or
  unsupported required controls fail preflight before a source replacement.
- Pluck/Lead one-shot recipes use a freshly staged Simpler with its default
  non-loop playback state. Optional envelope controls that cannot be matched
  are reported as skipped, consistent with the existing recipe behavior.
- Fallback targets reuse the corresponding synth profile's current targets;
  a fallback does not guess device names or controls.

## Sample search and suitability

- Keep the existing AND search semantics and ranking in `searchSampleIndex`.
  Each recipe supplies several specific query variants so a missing naming
  convention in one query can fall through to the next.
- Continue using the filename stem for suitability evidence. Parent folder
  names must not make an unrelated file appear to be a Pad, Pluck, Lead, loop,
  or one-shot.
- Preserve the existing drum/percussion/loop exclusion and Bass suitability
  logic for all current recipes.
- Add grouped evidence matching for new sample recipes. Every group must have
  at least one matching normalized term in the filename stem; this allows a
  recipe to require both a role family and its timbre family without accepting
  an unrelated file that matches only one broad word.
- For `loop` recipes, require an explicit loop marker such as `loop`, `looped`,
  or `looping` in the filename stem, plus the Pad/timbre evidence groups.
- For `one_shot` recipes, reject loop markers such as `loop`, `looped`,
  `looping`, or `phrase`, plus require the recipe's role/timbre evidence
  groups. A positive `one shot` token is not required because packs often omit
  it from one-shot filenames.
- If one query returns no suitable file, try the recipe's next query. If all
  queries fail or sample search raises an error, use that recipe's declared
  synth fallback and report the reason.

## Prompt routing

Keep sample recipes distinct from synth recipes. Select a sampled profile only
when the current request explicitly asks for a sample/sampled sound, or names
a sampled instrument such as guitar or kalimba.

1. Preserve explicit named Pluck sample sources: guitar/nylon/electric/muted
   guitar → `pluck_guitar`; kalimba/mbira/thumb piano → `pluck_kalimba`.
2. For an explicit sample request, resolve explicit timbre first:
   - Pad: warm/soft/mellow → `pad_warm_sample`; airy/shimmering/bright →
     `pad_airy_sample`; dark/cinematic/drone → `pad_dark_sample`.
   - Pluck: bright/short/punchy → `pluck_bright_sample`; warm/soft/mellow →
     `pluck_warm_sample`; bell/metallic/FM → `pluck_bell_sample`.
   - Lead: clean/clear/rounded → `lead_clean_sample`; analog/warm/vintage →
     `lead_analog_sample`; aggressive/bright/punchy →
     `lead_aggressive_sample`.
3. If a sample request gives only genre, use the current role mappings:
   - Pad: Ambient → airy; Cinematic → dark; House/Techno → warm.
   - Pluck: House/Techno → bright; Jazz/Bossa → warm; Pop/Cinematic → bell.
   - Lead: Pop → clean; Funk/Disco → analog; House/Techno → aggressive.
4. Without explicit sample intent, retain the existing synth recipe routes.
   If the request, relevant artist memory, and clearly identifiable current
   musical context do not resolve the timbre profile, ask one short question.

Never replace an explicitly named instrument implicitly. Apply recipes only to
the named or selected MIDI track and keep effects and all other Set content.

## Authorization and staged replacement

- Extend the current recipe intent parser to recognize explicit sample intent
  alongside Pad/Pluck/Lead role and timbre terms. The request must still
  contain an action plus a recipe ID or role/timbre intent to grant
  `sound_source`. This permission remains separate from generic device
  deletion authorization.
- Keep named/indexed target resolution, current selection scope, and YOLO
  behavior unchanged.
- Preflight the identified primary source and reject non-MIDI tracks, Racks,
  unknown devices, multiple primary instruments, and out-of-scope targets
  before mutation.
- For a new sample source on an existing track, insert a staging Simpler at
  the primary source position, apply required playback settings, import/load
  the selected sample, and apply its envelope. Only after those operations
  succeed, remove the old primary instrument. This preserves the original
  source if the staged recipe cannot be completed.
- If staging fails, remove the newly inserted Simpler and leave the original
  source in place. If cleanup also fails, report the partial state and the
  existing Live Undo recovery guidance.
- On an empty track, insert and configure Simpler; remove it if setup fails.
- For an existing Simpler primary source, stage a second Simpler for the new
  recipe/sample, then remove the original only after successful setup. Keep
  only one primary instrument after success.
- Preserve all effects and their order. Keep the final Simpler at the original
  primary source position.

## Failure behavior and result

- Unknown recipe ID: list all supported recipe IDs and do not mutate.
- No suitable sample after all queries: apply the recipe's declared synth
  fallback and include the current clear fallback note.
- Missing/duplicate role/timbre filename evidence: skip the file and continue
  through that recipe's queries.
- Missing/ambiguous required Pad loop controls: return a precise error before
  removing or replacing the current source; do not fall back to synth.
- Simpler insertion, sample loading, or envelope failure: preserve the old
  source through staged replacement; clean up the staged device, or report
  partial state and Undo guidance if cleanup fails.
- Successful results include recipe ID, role, sample/synth source, sample
  path when used, playback mode, applied/skipped controls, and listen hint.

## Verification

- Run `cd AIbleton && npm run build` and `git diff --check` after
  implementation.
- Do not add or run automated tests unless the user explicitly asks for
  tests or implementation verification.

## Known quality limit

Sample search is based on file/folder naming and does not decode samples to
measure their waveform, duration, or loop-point quality. The loop filename
marker and exact Simpler control checks reduce mismatches but cannot prove that
a loop is click-free. Final sound quality still requires auditioning in Live.
