# Genre-Aware Bass Sound Recipes — Design

## Goal

Make AIbleton choose and apply a reusable bass sound recipe that fits the music
style. The first release covers rock/band bass, reggae bass, pop bass,
electronic/dance bass, Hip-hop/R&B 808 or sub bass, Jazz, Bossa Nova, and Funk.
It should use the Live Set's actual devices and the user's locally available
samples instead of guessing parameter names or assuming a sample pack is
installed.

## User intent and success criteria

- A request for a bass sound should use the stated genre and role together.
- Rock bass should favor a picked or fingered electric-bass sample when one is
  available locally.
- Reggae bass should favor a warm, round electric-bass sample with a softer
  attack when one is available locally.
- Pop bass should support the song with a clean, controlled tone; choose an
  electric-bass sample or synth according to the pop substyle and current
  arrangement. If those clues are unclear, use a neutral Operator sound.
- Electronic/dance bass should use a synthesized bass sound.
- Hip-hop/R&B bass should favor an 808 or sub-bass sample.
- Jazz should default to a warm upright/double-bass sample; Fusion requests may
  choose a fingerstyle or flatwound electric-bass sample.
- Bossa Nova should favor a soft, rounded upright-bass sample with a gentle
  attack and controlled sustain.
- Funk should default to fingerstyle electric bass. Pick and slap recipes are
  selected only when the user asks for those techniques explicitly.
- When a sample route has no usable local result, use a clearly reported
  built-in-synth approximation rather than silently stopping.
- Application results should identify the chosen source and list parameter
  controls applied or skipped.
- YOLO mode should rely on the existing mutation authorization behavior: it
  applies the recipe without an additional confirmation prompt. Normal mode
  continues to use AIbleton's existing Allow flow.
- Timbre remains subjective. AIbleton should invite listening feedback and
  must not claim to have heard or measured a MIDI instrument through its device
  chain.

## Scope

### Included

- Eleven bass recipes:
  - `rock_bass`: local electric-bass sample, with a synth fallback.
  - `reggae_bass`: warm, round local electric-bass sample, softer attack, with
    a synth fallback.
  - `pop_bass`: clean, controlled bass; choose sample or synth from the
    substyle/arrangement, with Operator as the neutral fallback.
  - `electronic_bass`: Operator-based synthesized bass.
  - `hiphop_808_bass`: local 808/sub sample, with an Operator fallback.
  - `jazz_bass`: local upright/double-bass sample, with a warm synth fallback.
  - `jazz_fusion_bass`: fingerstyle/flatwound electric-bass sample.
  - `bossa_bass`: soft upright-bass sample with a warm synth fallback.
  - `funk_bass`: fingerstyle electric-bass sample, the default Funk recipe.
  - `funk_pick_bass`: picked electric-bass sample.
  - `funk_slap_bass`: slap electric-bass sample.
- A recipe catalog that stores each recipe's genre, role, source strategy,
  sample-search terms, target Live instrument, and parameter targets.
- A mutating `apply_sound_recipe` tool that runs a read-only preflight and then
  applies the selected recipe in the same tool call.
- Runtime matching against the target device's current parameter names,
  ranges, and enum options.
- Use of AIbleton's existing sample index, Simpler loading, device insertion,
  parameter setting, tool confirmation, and listen-hint paths where suitable.
- A clear result for selected sample/device, applied controls, skipped
  controls, and synth fallback.

### Excluded

- Pad and Pluck recipes.
- Genre-specific bassline rhythm, articulation, and note-pattern generation;
  this release changes timbre only.
- Genre classification from audio using a new classifier.
- Third-party plug-in loading or preset-file loading.
- Automatic rendering/listening analysis of MIDI instruments through their
  complete device chain.
- A new confirmation UI or a second confirmation layer in YOLO mode.

## Genre resolution

Resolve the recipe in this order:

1. An explicit genre or sound target in the current request.
2. A single relevant genre in the user's artist memory.
3. A clearly identified genre in the current conversation context.
4. If the genre is still ambiguous, ask a concise question before changing the
   sound source. YOLO skips mutation confirmation; it does not require the
   assistant to guess an ambiguous musical intent.

Do not infer a genre from unrelated artist-memory fields. Do not classify a
Set as a genre solely from a track name.

## Recipe and tool design

### Recipe catalog

Keep recipe data separate from dispatcher logic. Each recipe has a stable ID,
display name, genre/role tags, source strategy, ordered local search terms,
fallback instrument, and zero or more device-specific parameter targets. The
Reggae sample recipe should favor fingered, muted, or otherwise warm electric
bass samples and set a gentle Simpler envelope when the current device exposes
matching controls. Rock should favor a clearer picked/plucked attack; the
Hip-hop/R&B recipe should search for 808/sub samples.

Parameter targets use semantic aliases plus a normalized target value in
`[0, 1]`. At application time, convert that target to the current parameter's
reported `[min, max]` range. Enum targets use explicit option-name aliases and
are applied only when exactly one current option matches.

For `pop_bass`, explicit substyle terms in the current request take priority
(for example, pop-rock or dance-pop). Otherwise, use available arrangement
context to choose sample or synth; if that context does not point clearly to
one source, use the neutral Operator fallback.

For Jazz, use `jazz_bass` unless the request specifies Jazz Fusion or an
electric/flatwound tone, in which case use `jazz_fusion_bass`. Use `bossa_bass`
for Bossa Nova. For Funk, use `funk_bass` by default; select `funk_pick_bass`
or `funk_slap_bass` only when the user explicitly asks for that articulation.

### `apply_sound_recipe`

Inputs identify a track by the existing track index/name pair and a recipe ID.
`pop_bass` also accepts an optional `source_preference` (`sample` or `synth`)
when the substyle or arrangement makes the source clear. The tool will:

1. Resolve and validate the target track and recipe.
2. Inspect its current device chain and actual device parameters.
3. For sample recipes, query the existing local sample index using the
   recipe's ordered search terms and use the highest-ranked suitable result.
4. For sample recipes, load the selected sample into Simpler as the track's
   primary sound source. For synth recipes, reuse a compatible existing
   built-in instrument, replace only the primary instrument when needed, or
   insert the recipe's specified instrument on an empty MIDI track.
5. Apply only uniquely matched parameter targets whose values are supported
   by the Live device. Never guess a parameter or enum option.
6. Return the selected source, applied values, and any skipped targets.

Applying a named recipe to a named track authorizes changing that track's
primary sound source when the recipe requires it. Replace only that
instrument/source, preserve effects and all clips/mixer/other tracks, and use
the existing Allow dialog in normal mode. YOLO applies this scoped change
without a confirmation prompt. If the primary source cannot be identified
unambiguously, make no mutation and ask which device to target.

If sample search returns no suitable result, apply the recipe's declared
synth fallback and mark it clearly as an approximation. This fallback follows
the same scoped primary-source replacement rule.

### Authorization and feedback

Register the tool as a Set mutation so normal mode uses AIbleton's existing
Allow dialog. YOLO mode skips that dialog according to current behavior; the
tool must not add a conversational confirmation. When mutation succeeds,
attach the existing track-level listen hint so the user can audition the
result in Live.

## Failure behavior

- Unknown recipe: return the supported recipe IDs without touching the Set.
- Unsupported target track or ambiguous primary source: return a precise
  explanation and make no source replacement.
- No unique parameter match: skip that target and report why.
- Some parameter writes fail: report each applied and failed target; do not
  retry successful writes.
- Sample search unavailable or empty: use the recipe fallback only when the
  target track can accept it safely; otherwise leave the Set unchanged and
  report the blocker.
- A failed tool operation should follow existing dispatcher error and undo
  guidance.

## Testing plan

- Recipe catalog contains the eleven stable IDs and their intended source
  strategies.
- Genre resolution prioritizes the current explicit request and does not
  treat unrelated memory as the current genre.
- Parameter matching applies a unique alias, scales within the Live-reported
  range, resolves an enum by its exact/unique alias, and skips missing or
  ambiguous matches.
- Sample recipe chooses the highest-ranked local candidate and falls back
  when none exists.
- The dispatcher replaces only the targeted primary sound source, preserves
  unrelated effects/content, and reports partial parameter failures
  accurately.
- The tool uses standard mutation confirmation in normal mode and adds no
  separate confirmation path for YOLO mode.
- A successful application produces a listen hint for the target track.

## Open implementation constraint

AIbleton's existing rendered-track analysis renders Audio Tracks pre-FX and
does not expose the final sound of a MIDI instrument through its device chain.
Recipe validation can verify parameter writes and sample/device selection,
but final timbre quality still needs a human audition in Live.
