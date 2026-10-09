# Genre-Aware Instrument Selection Design

## Status

Draft for user review. No product code changes are part of this document.

## Goal

When a user asks for a genre-led part or arrangement without naming every instrument, AIbleton should choose suitable candidate parts and instruments, then use only sound recipes and sample sources the app can actually apply. The choice should reflect subgenre and musical function, preserve explicit user choices, and explain any fallback.

## Current problem

Genre guidance is split between prose in `prompts.ts` and a small table in `sound/genre-profiles.ts`. The table combines part labels, instrument names, and recipes in a single list. It has no subgenre model, no core-versus-optional distinction, and limited resource capability information. This has led to several confusing cases:

- Generic Keys was previously treated as Piano, even though Piano is one instrument within the Keys family.
- Rock, Jazz, and Funk have only a few role mappings; R&B has an 808/Sub Bass recipe but no full part profile.
- Some recipes are only approximations: `pluck_guitar` uses general guitar samples, and `keys_dx7_synth` is a DX7-style keyboard, not a Clavinet.
- A genre label can describe an instrument palette, but should not automatically create every possible track.

## Approaches considered

1. **Expand prompt prose only.** Fast to write, but mapping rules can conflict and are difficult to validate.
2. **Use typed genre profiles as the source of truth and render them into the prompt. Recommended.** Keeps supported genres, subgenres, candidate parts, instruments, recipe IDs, and fallbacks together; prompt generation remains compatible with the current agent/tool flow.
3. **Add a deterministic instrument-selection tool.** Could enforce a mapping before the model acts, but would add a new tool contract and prematurely lock subjective arrangement choices into code.

The first release uses approach 2. Profile data guides model choices; the model still chooses a suitable subset for a complete arrangement and does not create every listed part automatically.

## Proposed profile model

Represent each profile with:

- `genre` and optional `subgenre` aliases;
- candidate parts, each marked `core` or `optional`;
- the part role (for example Bass, Guitar, Piano, Keys, Lead, Pad);
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

Profiles should choose only mappings supported by the existing recipe catalog. Examples include Rock electric Bass and Guitar, Jazz upright Bass/Piano/warm Pluck, Funk Bass/analog Lead, and R&B 808/Sub Bass. A profile may list a role without a dedicated recipe only when it can use an existing role default safely; otherwise that role remains unresolved and prompts a concise question.

Subgenre changes the candidate instrument or recipe only when a corresponding recipe or a clear role default exists. Slap or pick Bass is chosen only for explicit technique or an explicitly named subgenre profile; otherwise use the existing fingerstyle Funk Bass recipe.

## Selection and safety rules

Apply these rules in order:

1. Preserve an explicitly named instrument or timbre.
2. Prefer an explicit subgenre in the current request, then its parent genre.
3. Use current Set context to avoid duplicating an existing role and to complement existing parts.
4. Use relevant artist memory only as a preference when the current request leaves a choice open; do not infer the current song's genre from artist memory.
5. For a full genre-led arrangement, choose a compact conventional subset from the profile's core and optional parts. For a named-part request, apply only that part's mapping.
6. Never replace an existing primary instrument implicitly.
7. If the recipe's sample cannot be found, use only its declared fallback and state the approximation. Do not describe a generic guitar sample as a genre-specific guitar tone or DX7 as a Clavinet.
8. If no suitable candidate or safe fallback exists, ask one concise question rather than inventing a recipe.

## Scope boundaries

- No new sound recipes, Live devices, third-party plug-ins, UI, or selection tool in this phase.
- No automatic replacement of existing sources.
- No requirement to create every candidate role in a profile.
- New recipe work for Clavinet, genre-specific electric guitar, or broader synth-keyboard sounds can follow after the profile table reveals the actual coverage gaps.

## Data flow

Typed profile data references existing recipes. A formatter resolves recipe labels, source types, and fallback instruments from `SOUND_RECIPES`, then injects a compact selection guide into the system prompt. The model uses that guide together with the current request and Set context before creating a part or applying a recipe.

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
- A complete arrangement selects a suitable subset instead of mechanically creating every listed role.
- Explicit user choices and existing instruments retain precedence and protection.
