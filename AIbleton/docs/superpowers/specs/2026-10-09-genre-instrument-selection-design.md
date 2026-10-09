# Genre-Aware Instrument Selection Design

## Status

Draft for user review. No product code changes are part of this document.

## Goal

When a user or arrangement has selected a part but not its instrument or timbre, AIbleton should use the requested genre/subgenre and the part's musical function to choose among supported sound recipes and sample sources. It should preserve explicit user choices and explain any fallback.

## Current problem

Genre guidance is split between prose in `prompts.ts` and a typed table in `sound/genre-profiles.ts`. Some mappings are duplicated in prose, and the profile formatter had started presenting core/optional roles as an arrangement template. That makes timbre guidance look like a restriction on which parts a genre can contain. Resource capability information is also limited. These issues have led to several confusing cases:

- Generic Keys was previously treated as Piano, even though Piano is one instrument within the Keys family.
- Rock, Jazz, and Funk have only a few role mappings; R&B has an 808/Sub Bass recipe but no full part profile.
- The legacy `pluck_guitar` recipe uses general guitar samples, and `keys_dx7_synth` is a DX7-style keyboard, not a Clavinet.
- A genre label can describe an instrument palette, but should not automatically create every possible track.

## Approaches considered

1. **Expand prompt prose only.** Fast to write, but mapping rules can conflict and are difficult to validate.
2. **Use typed genre profiles as the source of truth and render them into the prompt. Recommended.** Keeps supported genres, subgenres, role-to-instrument choices, recipe IDs, and fallbacks together; prompt generation remains compatible with the current agent/tool flow.
3. **Add a deterministic instrument-selection tool.** Could enforce a mapping before the model acts, but would add a new tool contract and prematurely lock subjective arrangement choices into code.

The first release uses approach 2. Profile data guides sound choices only after a role is selected. The model chooses roles from the user's request and normal arrangement reasoning, independent of the profile table.

## Proposed profile model

Represent each profile with:

- `genre` and optional `subgenre` aliases;
- role-to-sound mappings for parts that may already be selected (for example Bass, Guitar, Piano, Keys, Lead, Pad);
- one or more instrument candidates and a short condition for choosing among them;
- an existing `SoundRecipeId` when a supported recipe exists;
- source kind, fallback instrument, and a capability note when the recipe is approximate;
- a clear unresolved state when no supported recipe matches.

`Piano` is a specific instrument role separate from generic `Keys`. Only a Piano choice or a profile that explicitly selects Piano uses `keys_piano_sample`. Generic Keys can resolve to a supported Keys synth recipe when context fits; otherwise the assistant asks whether the user wants Piano or a synth/electric-keyboard sound.

## First-release coverage

The initial profile set covers Pop, Rock, Jazz, Funk, and R&B. Where useful it distinguishes:

- Pop Rock, Dance Pop, and Synth Pop;
- straight-ahead Jazz, Jazz Fusion, and Bossa Nova;
- fingerstyle Funk, slap/pick Funk, and Disco/Funk;
- Modern R&B, Neo-Soul, and trap-influenced R&B.

Profiles should choose only mappings supported by the recipe catalog. Examples include Rock electric Bass and overdrive Guitar, Jazz upright Bass/Piano/clean Guitar/warm Pluck, Funk finger/slap Bass and muted Guitar, and R&B 808/Sub Bass. Guitar is the one approved expansion beyond existing recipes: add acoustic/nylon, clean electric/hollowbody, muted/Funk, and overdrive/distortion one-shot sample recipes. Each requires flavor-specific filename evidence and a declared synth fallback; no matching sample must be reported as an approximation. Other roles without a dedicated recipe use an existing role default or remain unresolved.

Subgenre changes the candidate instrument or recipe only when a corresponding recipe or a clear role default exists. Slap or pick Bass is chosen only for explicit technique or an explicitly named subgenre profile; otherwise use the existing fingerstyle Funk Bass recipe.

## Selection and safety rules

Apply these rules in order:

1. Preserve an explicitly named instrument or timbre.
2. Prefer an explicit subgenre in the current request, then its parent genre.
3. Use current Set context to avoid duplicating an existing role and to complement existing parts.
4. Use relevant artist memory only as a preference when the current request leaves a choice open; do not infer the current song's genre from artist memory.
5. Profiles never choose, require, omit, forbid, or whitelist roles. For a named part, apply only that role's profile mapping; for a full arrangement, choose parts from the user's request and normal arrangement reasoning, then use profiles for their sound.
6. Never replace an existing primary instrument implicitly.
7. If the recipe's sample cannot be found, use only its declared fallback and state the approximation. Do not describe a generic guitar sample as a genre-specific guitar tone or DX7 as a Clavinet.
8. If no suitable candidate or safe fallback exists, ask one concise question rather than inventing a recipe.

## Scope boundaries

- No new sound recipes beyond the four approved Guitar variants above; no new Live devices, third-party plug-ins, UI, or selection tool.
- No automatic replacement of existing sources.
- Genre profiles do not restrict which roles may appear.
- Clavinet, genre-specific synth guitar, and broader synth-keyboard recipes remain out of scope; do not present a fallback approximation as the real instrument.

## Data flow

Typed profile data references existing recipes. A formatter resolves recipe labels, source types, and fallback instruments from `SOUND_RECIPES`, then injects a compact sound-selection guide into the system prompt. The user request and normal arrangement reasoning select roles; the model uses the profile guide and current Set context only after a role is selected.

## Validation

- Unit tests cover profile aliases, subgenre precedence, role/instrument separation, supported recipe/source/fallback references, and unresolved combinations.
- Prompt tests confirm explicit instrument priority, current-genre priority over artist-memory genre, no implicit source replacement, and profile-derived instructions.
- Integration tests cover Pop/Rock/Jazz/Funk/R&B profile resolution without requiring Ableton Live.
- Run the full test suite and production build.

## Acceptance criteria

- Profile data is the single source for the new genre/subgenre mappings; the same mapping is not separately hand-written in prompt prose.
- Piano and generic Keys resolve differently.
- R&B distinguishes at least Modern R&B, Neo-Soul, and trap-influenced R&B where existing recipes permit; unresolved choices are explicit.
- Rock/Jazz/Funk mappings cover instrument choices beyond Bass where available, with capability notes for approximate recipes.
- Acoustic/clean/muted/overdrive Guitar mappings use distinct recipe IDs, sample query/evidence, one-shot behavior, and declared fallbacks.
- Profiles only guide sounds for selected roles and do not restrict a complete arrangement's role lineup.
- Explicit user choices and existing instruments retain precedence and protection.

## Amendment: profiles do not choose the role lineup (2026-10-09)

The genre-profile layer only maps a role that the user or arrangement has already selected to suitable instrument/timbre recipes. It must not choose, require, omit, forbid, or whitelist roles based on genre. Part selection for a complete arrangement remains with the assistant's normal arrangement reasoning and the user's request; the profile supplies sound choices once a role is selected.

This amendment supersedes the earlier `core`/`optional` role priorities and the acceptance criterion that asked a full arrangement to select a subset from those priorities. Profiles must not encode arrangement-level role priority. They may still use subgenre overrides for the timbre choices of named roles, recipe capabilities, and safe fallbacks.
