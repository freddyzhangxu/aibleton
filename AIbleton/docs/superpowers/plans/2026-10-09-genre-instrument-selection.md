# Genre-Aware Instrument Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use one typed, testable profile catalog to map already selected roles to suitable instruments, recipes, and safe fallbacks for Pop, Rock, Jazz, Funk, and R&B, including useful subgenres.

**Architecture:** Extend `src/sound/genre-profiles.ts` into the single source of truth for genre and subgenre aliases, role-to-sound mappings, instrument choices, recipe references, conditions, and limitations. Render that data into the existing system prompt and align the `apply_sound_recipe` tool description; keep actual recipe execution in the current recipe dispatcher and do not add a new selector tool.

**Tech Stack:** TypeScript, Node.js built-in test runner via `tsx`, existing `SOUND_RECIPES` catalog.

**Spec:** `docs/superpowers/specs/2026-10-09-genre-instrument-selection-design.md`

## Global Constraints

- No new sound recipes, Live devices, third-party plug-ins, UI, or selection tool in this phase.
- No automatic replacement of existing sources.
- Profiles only guide timbre for already selected roles; they do not determine the role lineup.
- Profile data references existing recipes; source kind and fallback are derived from `SOUND_RECIPES`.
- Explicit instrument/timbre selection takes precedence over profile guidance.
- Subgenre guidance takes precedence over its parent genre.
- Unsupported combinations remain unresolved; never invent a recipe or overstate an approximation.

## Review Focus

- **Unknown subgenre:** use the parent genre's supported parts and leave unknown role choices unresolved; test a made-up R&B subtype.
- **Specific aliases:** “synth pop” and “jazz fusion” must use their subgenre override; test alias lists and override rendering.
- **Keys versus Piano:** only Piano or a profile that explicitly chooses Piano may select `keys_piano_sample`; test generic Keys stays distinct.
- **Approximate resources:** general guitar samples and DX7-style Keys must carry capability notes; test source/fallback metadata and prompt text.
- **Explicit/current context precedence:** explicit instruments win and existing sources are preserved; test the prompt contract for both.

---

### Task 1: Define the profile schema and formatter

**Files:**
- Modify: `src/sound/genre-profiles.ts`
- Create: `src/sound/genre-profiles.test.ts`

**Interfaces:**
- Produces `GenreProfile`, `GenreSubgenreProfile`, `GenrePartProfile`, and `GenreInstrumentChoice` types.
- Keeps `GENRE_INSTRUMENT_PROFILES` and `genreInstrumentProfilePrompt()` as the public data and prompt-formatting interfaces.
- A choice contains `instrument`, optional `recipe`, optional `sourcePreference`, optional condition, and optional capability note. Recipe source and fallback are read from `SOUND_RECIPES` at format time.
- A part is marked `core` or `optional`; a subgenre may override only the roles it changes, leaving other parent-genre parts inherited.

- [ ] **Step 1: Write the failing formatter tests**

Create `src/sound/genre-profiles.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { genreInstrumentProfilePrompt } from "./genre-profiles.js";

test("profile guide distinguishes core and optional parts and gives subgenres precedence", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Core parts/);
  assert.match(guide, /Optional parts/);
  assert.match(guide, /An explicit subgenre overrides the parent genre for listed roles/);
  assert.match(guide, /If no listed subgenre matches, retain the parent genre profile/);
  assert.match(guide, /Leave unsupported role and genre combinations unresolved and ask one concise question/);
});

test("profile guide derives recipe source and fallback from the recipe catalog", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /rock_bass, sample; fallback Operator/);
  assert.match(guide, /keys_dx7_synth, synth Operator; fallback Operator/);
});
```

- [ ] **Step 2: Run tests to verify the new contract fails**

Run: `npx tsx --test src/sound/genre-profiles.test.ts`

Expected: FAIL because the current profile formatter has no core/optional distinction or subgenre override instruction.

- [ ] **Step 3: Add the typed profile model and formatter**

In `src/sound/genre-profiles.ts`, define a finite part-role union and data types with these fields:

```ts
type GenrePartRole = "Bass" | "Guitar" | "Piano" | "Keys" | "Lead" | "Melody" | "Pad" | "Pluck";
type GenreInstrumentChoice = {
  instrument: string;
  recipe?: SoundRecipeId;
  sourcePreference?: "sample" | "synth";
  when?: string;
  capabilityNote?: string;
};
type GenrePartProfile = {
  role: GenrePartRole;
  choices: readonly GenreInstrumentChoice[];
};
type GenreSubgenreProfile = {
  label: string;
  aliases: readonly string[];
  overrides: readonly GenrePartProfile[];
};
type GenreProfile = {
  label: string;
  aliases: readonly string[];
  coreParts: readonly GenrePartProfile[];
  optionalParts: readonly GenrePartProfile[];
  subgenres: readonly GenreSubgenreProfile[];
};
```

Update `genreInstrumentProfilePrompt()` to render parent profiles and subgenre overrides, mark core and optional parts, state that a matching subgenre overrides the parent for its listed roles, and retain the parent when no listed subgenre matches. Resolve each recipe's source/fallback from `SOUND_RECIPES`; render `sourcePreference` for contextual Bass choices. Keep one-line capability notes beside the affected choice.

- [ ] **Step 4: Run the profile tests and confirm they pass**

Run: `npx tsx --test src/sound/genre-profiles.test.ts`

Expected: both tests PASS with recipe data and profile structure rendered.

- [ ] **Step 5: Commit the profile schema and formatter**

```bash
git add src/sound/genre-profiles.ts src/sound/genre-profiles.test.ts
git commit -m "refactor: model genre instrument profiles"
```

### Task 2: Populate supported genre and subgenre mappings

**Files:**
- Modify: `src/sound/genre-profiles.ts`
- Test: `src/sound/genre-profiles.test.ts`

**Interfaces:**
- Consumes the profile types and formatter from Task 1.
- Populates profiles for Pop, Rock, Jazz, Funk, and R&B using existing recipe IDs only.
- Parent profiles use aliases; subgenre profiles override only the roles with a supported alternative.

- [ ] **Step 1: Add failing tests for representative mappings**

Add tests asserting profile guide output includes these cases:

```ts
test("profiles resolve representative parent genres and subgenres", () => {
  const guide = genreInstrumentProfilePrompt();
  assert.match(guide, /Pop Rock.*rock_bass/);
  assert.match(guide, /Dance Pop.*electronic_bass/);
  assert.match(guide, /Straight-ahead Jazz.*jazz_bass/);
  assert.match(guide, /Jazz Fusion.*jazz_fusion_bass/);
  assert.match(guide, /Bossa Nova.*bossa_bass/);
  assert.match(guide, /Funk Slap.*funk_slap_bass/);
  assert.match(guide, /Modern R&B.*hiphop_808_bass/);
  assert.match(guide, /Neo-Soul.*pop_bass.*sample/);
  assert.match(guide, /Trap-influenced R&B.*hiphop_808_bass/);
  assert.match(guide, /R&B aliases: R&B, R and B, rhythm and blues/);
  assert.match(guide, /Jazz Fusion aliases: jazz fusion, fusion/);
});
```

- [ ] **Step 2: Run the profile test to confirm it fails**

Run: `npx tsx --test src/sound/genre-profiles.test.ts`

Expected: FAIL because the initial table does not yet contain the complete first-release profile set.

- [ ] **Step 3: Add profiles using existing supported recipes**

Populate the profile data as follows:

- Pop core: contextual `pop_bass`, `lead_clean`, and `pluck_bell`; Pop Rock overrides Bass with `rock_bass`; Dance Pop and Synth Pop override Bass with `electronic_bass`.
- Rock core: `rock_bass` and the existing general `pluck_guitar` sample. Piano is optional via `keys_piano_sample`; synth-rock may offer `keys_dx7_synth` with its DX7 capability note.
- Jazz core: `jazz_bass` and Piano via `keys_piano_sample`; Guitar and warm Pluck are optional. Jazz Fusion overrides Bass with `jazz_fusion_bass`; Bossa Nova overrides Bass with `bossa_bass`.
- Funk core: `funk_bass`; Guitar and FM Keys are optional via `pluck_guitar` and `keys_dx7_synth`; Lead/Melody may use `lead_analog`. Slap and pick subgenres override Bass only when named by the request.
- R&B core: Modern R&B and trap-influenced R&B may use `hiphop_808_bass`. Neo-Soul uses the contextual `pop_bass` sample option only for a band/acoustic arrangement. Keys may use the existing DX7-style recipe only where that approximation fits; otherwise ask. Do not claim it is a Clavinet or authentic Rhodes preset.

Add aliases for common spellings (`R&B`, `R and B`, `rhythm and blues`, `neo-soul`/`neosoul`, `trap R&B`, `pop-rock`, and `synth-pop`). Mark remaining supported role choices optional; leave unsupported combinations unresolved. For an unknown subgenre, the formatter must tell the model to retain the parent genre's core and optional parts rather than guessing a subgenre override.

- [ ] **Step 4: Run the profile tests and confirm mappings pass**

Run: `npx tsx --test src/sound/genre-profiles.test.ts`

Expected: all profile tests PASS, including parent/subgenre mapping and recipe source/fallback checks.

- [ ] **Step 5: Commit the genre profiles**

```bash
git add src/sound/genre-profiles.ts src/sound/genre-profiles.test.ts
git commit -m "feat: add subgenre instrument profiles"
```

### Task 3: Integrate profile guidance and remove conflicting prose

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/tools/definitions.ts`
- Test: `src/prompts.test.ts`
- Test: `src/tools/definitions.test.ts`

**Interfaces:**
- Consumes `genreInstrumentProfilePrompt()` from Task 1 and the populated profiles from Task 2.
- Adds the profile output once to `systemPromptFor()` and removes duplicated genre-to-recipe mappings from the hand-written Bass/Keys instructions.
- Keeps general precedence, recipe execution safety, sample search and fallback rules in the prompts/tool description.

- [ ] **Step 1: Write failing integration assertions**

Add to `src/prompts.test.ts` assertions that `systemPromptFor("en")`:

```ts
assert.match(prompt, /explicit subgenre overrides the parent genre/);
assert.match(prompt, /Modern R&B/);
assert.match(prompt, /Generic Keys does not default to piano samples/);
assert.match(prompt, /explicitly named instrument or timbre takes precedence/i);
assert.match(prompt, /never replace an existing instrument implicitly/i);
assert.doesNotMatch(prompt, /Generic Keys defaults to keys_piano_sample/);
```

Also assert the generated prompt says the current request's genre/subgenre precedes artist memory and that explicit instruments and existing primary sources are preserved.

Add to `src/tools/definitions.test.ts` assertions that the `apply_sound_recipe` description says generic Keys is not Piano by default and keeps sample fallback instructions.

- [ ] **Step 2: Run integration tests to confirm the old instructions fail**

Run: `npx tsx --test src/prompts.test.ts src/tools/definitions.test.ts`

Expected: FAIL on old hand-written mappings or old Generic Keys default language.

- [ ] **Step 3: Render the table once and align the tool description**

Use `genreInstrumentProfilePrompt()` once in `systemPromptFor()`. Remove duplicated Pop/Rock/Jazz/Funk Bass mappings that now live in profile data. Keep Keys/Piano distinction: explicit Piano or a profile naming Piano can choose `keys_piano_sample`; generic Keys resolves from role/context or asks; explicit DX7/FM/electric piano/Rhodes selects `keys_dx7_synth`. Update `apply_sound_recipe` description to the same contract and preserve authorization, sample-match, and Undo guidance.

- [ ] **Step 4: Run focused integration tests**

Run: `npx tsx --test src/prompts.test.ts src/tools/definitions.test.ts`

Expected: all prompt and tool-description tests PASS with no stale generic-Piano default wording.

- [ ] **Step 5: Commit prompt integration**

```bash
git add src/prompts.ts src/prompts.test.ts src/tools/definitions.ts src/tools/definitions.test.ts
git commit -m "feat: use genre profiles for instrument guidance"
```

### Task 4: Run final verification and inspect the integrated diff

**Files:**
- Review: `src/sound/genre-profiles.ts`
- Review: `src/prompts.ts`
- Review: `src/tools/definitions.ts`
- Review: `src/sound/genre-profiles.test.ts`, `src/prompts.test.ts`, and `src/tools/definitions.test.ts`

- [ ] **Step 1: Run focused profile and integration tests**

Run: `npx tsx --test src/sound/genre-profiles.test.ts src/prompts.test.ts src/tools/definitions.test.ts`

Expected: all profile, precedence, Keys/Piano, and tool-description tests PASS.

- [ ] **Step 2: Run the complete project test suite**

Run: `npm test`

Expected: all project tests PASS with 0 failures.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: TypeScript check and production bundle succeed.

- [ ] **Step 4: Check whitespace and review changed files**

Run: `git diff --check`

Expected: no whitespace errors. Confirm `src/server.ts` and `src/setcontext.ts` remain untouched.

## Execution note

Before implementation, use the `using-git-worktrees` skill to choose an isolated execution workspace if the approved execution method requires it. Preserve unrelated workspace edits in `src/server.ts` and `src/setcontext.ts`.

## Approved follow-up amendment: keep role selection independent

The user clarified that genre profiles should guide timbre only after a role is selected. They must not tell the model which roles to create or omit. The updated design is recorded in the Spec amendment. This supersedes the earlier `coreParts` / `optionalParts` structure and the full-arrangement subset instruction.

### Task 5: Make profiles sound maps, not role lineups

**Files:**
- Modify: `src/sound/genre-profiles.ts`
- Modify: `src/prompts.ts`
- Modify: `src/tools/definitions.ts`
- Test: `src/sound/genre-profiles.test.ts`
- Test: `src/prompts.test.ts`
- Test: `src/tools/definitions.test.ts`

**Interfaces:**
- Keep `GenrePartProfile` and `GenreInstrumentChoice` mappings from a selected role to supported instruments/recipes.
- Replace `GenreProfile.coreParts` and `.optionalParts` with one role mapping list; preserve subgenre overrides.
- `genreInstrumentProfilePrompt()` states that profiles only guide the sound of already selected roles, and never add, omit, require, forbid, or whitelist roles.

- [ ] **Step 1: Write and run failing boundary tests**

The new assertions in `src/sound/genre-profiles.test.ts` and `src/prompts.test.ts` assert that the profile guide maps timbre for an already selected role and omits the `Core parts` / `Optional parts` and compact-subset language. Extend `src/tools/definitions.test.ts` to assert the tool description no longer calls genre profiles a core/optional role lineup.

Run: `npx tsx --test src/sound/genre-profiles.test.ts src/prompts.test.ts src/tools/definitions.test.ts`

Expected: FAIL because the current profile data and prompt still include role priority and compact-subset instructions.

- [ ] **Step 2: Remove role priority from profile data and formatter**

In `src/sound/genre-profiles.ts`, replace `coreParts` and `optionalParts` with `parts: readonly GenrePartProfile[]`. Flatten existing role mappings without changing recipe choices, aliases, source preferences, capability notes, or subgenre overrides. Format the parent genre's entries as sound mappings by role; do not label them core or optional.

In `genreInstrumentProfilePrompt()`, state that the table only chooses a sound for an already selected role; it never chooses, requires, omits, forbids, or whitelists roles. Keep the parent/subgenre fallback and unsupported-timbre guidance.

- [ ] **Step 3: Remove arrangement constraints from prompt and tool text**

In `src/prompts.ts`, replace the compact-subset instruction with the role/timbre-only rule. In `src/tools/definitions.ts`, describe profiles as role-to-sound mappings and remove the statement that they define core/optional parts. Keep genre/subgenre priority, explicit instrument precedence, existing-source protection, recipe authorization, and declared fallbacks unchanged.

- [ ] **Step 4: Run focused regression tests**

Run: `npx tsx --test src/sound/genre-profiles.test.ts src/prompts.test.ts src/tools/definitions.test.ts`

Expected: all focused tests PASS; the profile guide contains no role-lineup restriction and retains every sound mapping.

- [ ] **Step 5: Commit the role-selection boundary change**

```bash
git add src/sound/genre-profiles.ts src/sound/genre-profiles.test.ts src/prompts.ts src/prompts.test.ts src/tools/definitions.ts src/tools/definitions.test.ts docs/superpowers/specs/2026-10-09-genre-instrument-selection-design.md docs/superpowers/plans/2026-10-09-genre-instrument-selection.md
git commit -m "fix: keep genre profiles from limiting roles"
```
