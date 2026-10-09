# Sampled Pad, Pluck, and Lead Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine reusable sample recipes across Pad, Pluck, and Lead, with looped Pad playback, pitched one-shot Pluck/Lead playback, explicit source routing, and failure-safe replacement.

**Architecture:** Extend the shared recipe catalog with playback intent and grouped filename evidence. Keep the existing sample search and exact parameter matching; stage a new Simpler and complete required setup before replacing the current primary source. Route to sample recipes only on explicit sample intent, preserving the current synth defaults and named guitar/kalimba Pluck routes.

**Tech Stack:** TypeScript, Ableton Extensions SDK, shared sound recipe catalog, sample metadata search, Simpler device parameters, prompt generation, source authorization, and postcondition verification.

**Spec:** `docs/superpowers/specs/2026-10-09-sampled-pad-pluck-lead-recipes-design.md`

## Global Constraints

- Preserve all eleven Bass recipes and the nine existing Pad/Pluck/Lead synth recipes.
- Preserve `pluck_guitar` and `pluck_kalimba`, including their IDs, sample queries, filename evidence, and synth fallbacks.
- Add nine sample recipes: `pad_warm_sample`, `pad_airy_sample`, `pad_dark_sample`, `pluck_bright_sample`, `pluck_warm_sample`, `pluck_bell_sample`, `lead_clean_sample`, `lead_analog_sample`, and `lead_aggressive_sample`.
- Pad sample recipes use loop-marked files and require exact Simpler `Mode = Classic` and `Loop = On` controls.
- Pluck/Lead sample recipes reject loop-marked files and use a newly staged Simpler in its default non-loop playback state.
- New recipes use exact aliases, fixed built-in synth fallbacks, and grouped filename evidence; sample suitability checks the filename stem rather than parent folders.
- Pad loop-control failure refuses the change without falling back to a synth. A missing suitable file may use the declared synth fallback with a clear note.
- Preserve current MIDI-only and primary-source preflight, target scope, `sound_source` authorization, YOLO behavior, effects, clips, mixer state, and Undo recovery.
- Do not add or run automated tests unless the user explicitly asks for tests or implementation verification. Use production build, diff checks, and source review.

## Review Focus

- A file with `loop` in a parent folder but not its filename stem must not be accepted as a Pad loop; inspect evidence matching in Task 2.
- New one-shot Pluck/Lead recipes must reject loop/phrase files while legacy sample Pluck recipes retain their existing matching behavior; inspect Task 2 routing.
- Pad mode/Loop aliases must be found uniquely before importing the sample; inspect Task 3 preflight and cleanup.
- A matched sample on a MIDI track with an existing primary instrument must be refused without changing that source; inspect the guard in Task 3.
- Sample load/envelope failure on a track without a primary instrument must clean up the inserted Simpler; inspect Task 3 cleanup reporting.
- No sample intent must continue to choose synth profiles; an explicit sample request with no matching file must use only the declared fallback and report it; inspect Task 4 prompt and result text.

---

## File Map

- Modify `AIbleton/src/sound/recipes.ts` — add the playback mode/evidence group metadata, nine sample IDs, Simpler targets, sample queries, and declared fallbacks.
- Modify `AIbleton/src/tools/soundrecipes.ts` — apply grouped filename evidence/playback checks and safely load new sample recipes only when the target has no primary instrument; keep the legacy sample path for existing recipes.
- Modify `AIbleton/src/prompts.ts` — derive sample recipe groups from the catalog and route explicit sample requests without changing synth defaults or named guitar/kalimba routing.
- Modify `AIbleton/src/chat/deleteauth.ts` — recognize sample intent with Pad/Pluck/Lead role/timbre while granting only existing `sound_source` authorization.
- Modify `AIbleton/src/tools/definitions.ts` — document sample playback modes, search fallback, and required Pad loop support.
- Review `AIbleton/src/verify/rules.ts`, `AIbleton/src/tools/listenhint.ts`, and `AIbleton/src/selectionguard.ts` — change only if the existing generic source, listen, or target-scope behavior does not cover the new result.

## Tasks

### Task 1: Add sample playback metadata and nine catalog recipes

**Files:**

- Modify `AIbleton/src/sound/recipes.ts`

**Interfaces:**

- `SoundRecipe` adds optional `samplePlayback?: "loop" | "one_shot"` and `sampleEvidenceGroups?: readonly (readonly string[])[]`.
- Existing `sampleEvidence` remains supported unchanged for `pluck_guitar` and `pluck_kalimba`.
- `SoundRecipeId` adds the nine IDs from the Global Constraints; `SOUND_RECIPE_IDS` remains derived from `SOUND_RECIPES`.
- New sample recipes have `role` matching their prefix, `source: "sample"`, a fixed `fallbackInstrument`, Simpler targets, and target arrays for the fallback synth.

- [ ] **Step 1: Extend the recipe interface and ID union.** Add optional `samplePlayback` and `sampleEvidenceGroups` fields without changing existing sample recipe metadata.
- [ ] **Step 2: Define Simpler target arrays.** Use exact current envelope aliases `Amp Attack`, `Amp Decay`, `Amp Sustain`, and `Amp Release`. For Pad, add enum targets for `Mode`/`Playback Mode` with option `Classic`, and `Loop` with option `On`; these are required playback controls. Keep targets for one-shot recipes limited to envelope controls.
- [ ] **Step 3: Add the nine recipes with their fixed fallbacks.** Pad warm/airy/dark fall back to Drift/Wavetable/Operator; Pluck bright/warm/bell fall back to Wavetable/Drift/Operator; Lead clean/analog/aggressive fall back to Drift/Drift/Wavetable. Reuse the existing synth profile target arrays for each fallback device.
- [ ] **Step 4: Add fixed search queries and evidence groups.** Use these query variants and role/timbre evidence groups (each group is any-of; all groups are required):

| Recipe | `sampleQueries` | Evidence groups |
|---|---|---|
| `pad_warm_sample` | `warm pad loop`, `soft pad loop`, `analog pad loop` | `[pad, atmosphere, texture, drone]`; `[warm, soft, mellow, analog]` |
| `pad_airy_sample` | `airy pad loop`, `shimmering pad loop`, `ambient pad loop` | `[pad, atmosphere, texture]`; `[airy, shimmer, shimmering, bright]` |
| `pad_dark_sample` | `dark pad loop`, `cinematic pad loop`, `dark drone loop` | `[pad, drone, texture]`; `[dark, cinematic, moody]` |
| `pluck_bright_sample` | `bright pluck`, `bright mallet`, `bright marimba` | `[pluck, mallet, marimba, glockenspiel, kalimba]`; `[bright, crisp, punchy, bell]` |
| `pluck_warm_sample` | `warm pluck`, `soft guitar pluck`, `warm kalimba` | `[pluck, guitar, nylon, kalimba, mbira]`; `[warm, soft, mellow, nylon]` |
| `pluck_bell_sample` | `bell pluck`, `metallic mallet`, `bell kalimba` | `[pluck, kalimba, mallet, bell, glockenspiel]`; `[bell, metallic, tine, bright]` |
| `lead_clean_sample` | `clean synth lead`, `clear synth lead`, `clean keyboard lead` | `[lead, synth lead, mono lead, keyboard lead]`; `[clean, clear, rounded, pristine]` |
| `lead_analog_sample` | `analog synth lead`, `warm analog lead`, `vintage synth lead` | `[lead, synth lead, mono lead]`; `[analog, vintage, warm, retro]` |
| `lead_aggressive_sample` | `aggressive synth lead`, `distorted synth lead`, `bright mono lead` | `[lead, synth lead, mono lead]`; `[aggressive, distorted, dirty, hard, gritty]` |

- [ ] **Step 5: Add the normalized Simpler envelopes.** Use `(attack, decay, sustain, release)` in `[0, 1]`: `pad_warm_sample` `(0.12, 0.68, 0.78, 0.62)`; `pad_airy_sample` `(0.2, 0.62, 0.72, 0.78)`; `pad_dark_sample` `(0.16, 0.62, 0.64, 0.7)`; `pluck_bright_sample` `(0.0005, 0.22, 0.08, 0.04)`; `pluck_warm_sample` `(0.002, 0.3, 0.16, 0.08)`; `pluck_bell_sample` `(0.0001, 0.18, 0.02, 0.04)`; `lead_clean_sample` `(0.006, 0.28, 0.58, 0.1)`; `lead_analog_sample` `(0.012, 0.35, 0.64, 0.15)`; `lead_aggressive_sample` `(0.0005, 0.28, 0.48, 0.04)`. Reuse fallback target arrays exactly: `pad_warm` → `driftWarmPadControls`; `pad_airy` → `wavetableAiryPadControls`; `pad_dark` → `operatorDarkPadControls`; `pluck_bright` → `wavetableBrightPluckControls`; `pluck_warm` → `driftWarmPluckControls`; `pluck_bell` → `operatorBellPluckControls`; `lead_clean` → `driftCleanLeadControls`; `lead_analog` → `driftAnalogLeadControls`; `lead_aggressive` → `wavetableAggressiveLeadControls`. Do not add new device aliases.
- [ ] **Step 6: Run the production build and inspect the catalog.** Run `cd AIbleton/AIbleton && npm run build`, then `git diff --check`. Confirm the existing 22 recipes are unchanged, the nine new IDs appear exactly once, and the resulting catalog has 31 IDs.
- [ ] **Step 7: Commit the catalog.**

```bash
git add AIbleton/src/sound/recipes.ts
git commit -m "feat: add sampled pad pluck lead recipes"
```

### Task 2: Enforce grouped evidence and playback suitability

**Files:**

- Modify `AIbleton/src/tools/soundrecipes.ts`

**Interfaces:**

- `isSuitableSample(recipe, filePath)` continues to receive the selected catalog recipe and candidate file path.
- New `sampleEvidenceGroups` require at least one stem match per group; old `sampleEvidence` retains its current any-of behavior.

- [ ] **Step 1: Extract normalized filename-stem matching.** Use the existing basename-without-extension behavior, NFKC normalization, and compact alphanumeric comparison. Do not use parent directories for suitability evidence.
- [ ] **Step 2: Preserve the current drum/percussion exclusion.** Keep the existing full drum/percussion filename regex unchanged for legacy recipes, including its kick, snare, clap, hi-hat, cymbal, tom, rim, drum, percussion/perc, loop, and fill terms. A new recipe with `samplePlayback: "loop"` may accept an explicit loop marker only after passing its Pad evidence groups.
- [ ] **Step 3: Apply playback filters only to recipes that declare `samplePlayback`.** For `loop`, require a stem marker `loop`, `looped`, or `looping`. For `one_shot`, reject `loop`, `looped`, `looping`, or `phrase`. Leave recipes without playback metadata on their current suitability path.
- [ ] **Step 4: Require all evidence groups for new recipes.** For each group, normalize its terms and require at least one term in the stem. Keep the existing `sampleEvidence` fallback for the two legacy Pluck recipes.
- [ ] **Step 5: Preserve query fallback order.** `findSample` must keep searching the remaining `sampleQueries` after an unsuitable result; return the first candidate that passes all drum, playback, and evidence checks.
- [ ] **Step 6: Run the production build and diff check.** Run `cd AIbleton/AIbleton && npm run build` and `git diff --check`; inspect that legacy Bass and Pluck decisions remain on their existing branches and parent folder terms cannot satisfy the new evidence groups.
- [ ] **Step 7: Commit sample suitability changes.**

```bash
git add AIbleton/src/tools/soundrecipes.ts
git commit -m "feat: filter samples by role and playback"
```

### Task 3: Apply sample recipes only when no primary instrument exists

**Files:**

- Modify `AIbleton/src/tools/soundrecipes.ts`
- Review `AIbleton/src/verify/rules.ts`, `AIbleton/src/tools/listenhint.ts`, and `AIbleton/src/tools/selectionguard.ts`.

**Interfaces:**

- `applySoundRecipe(context, input)` keeps its existing input shape: `track_index`, `track_name`, `recipe_id: SoundRecipeId`, and optional `source_preference` for `pop_bass` only.
- Successful new sample results include `role`, `recipe`, `track`, `source.kind`, `source.device`, the sample `source.file` and `source.playback_mode` when a sample loaded, `applied`, `skipped`, and existing `listen_hint`. Synth fallback results retain `source.kind: "synth"` and the fallback note.

- [ ] **Step 1: Keep legacy sample recipes on their existing path.** Branch into the new helper only for recipes that declare `samplePlayback`; leave Bass, `pluck_guitar`, and `pluck_kalimba` source replacement and fallback unchanged.
- [ ] **Step 2: Refuse occupied primary-source tracks before mutation.** When a suitable sample is found for a new playback-mode recipe, if `current` is any primary instrument (including Simpler), return `sample_source_replacement_unsupported: true`, include the current device name, and say to choose a MIDI track with no primary instrument. Do not insert Simpler, import the sample, delete a source, or add a fallback in this case.
- [ ] **Step 3: Insert Simpler only on a track without a primary instrument.** Use device index 0 so any existing audio effects remain downstream and in order. Record the inserted device handle for cleanup.
- [ ] **Step 4: Preflight required Pad playback targets before importing the sample.** Match recipe targets against the inserted Simpler parameters. For `samplePlayback: "loop"`, require unique `Mode`/`Playback Mode` with option `Classic` and unique `Loop` with option `On`. If a required target is missing, duplicated, unquantized, or has no matching option, delete the inserted Simpler and return an error.
- [ ] **Step 5: Apply loop settings before replacing the sample.** Set Mode to Classic before Loop to On. If a setting fails, clean up the inserted device. One-shot recipes use the new Simpler's default non-loop state.
- [ ] **Step 6: Import and load the selected sample, then set its envelope.** Import into the project only after required Pad playback controls pass preflight. On sample-load failure or a matched-target write failure, remove the inserted Simpler. Missing/ambiguous optional envelope aliases remain reported as skipped.
- [ ] **Step 7: Handle cleanup failure explicitly.** On cleanup, remove the created-device registry entry when deletion succeeds. If deleting the inserted Simpler after a failed setup also fails, return a partial-state result with device names and Live Undo guidance. Do not retry automatically.
- [ ] **Step 8: Keep no-match fallback and loop-control failure distinct.** If all sample queries fail or throw, follow the existing declared-synth fallback and note. If Pad loop controls cannot be matched or set, fail closed without synth fallback.
- [ ] **Step 9: Preserve verification and listen feedback.** Confirm `verify/rules.ts` checks the inserted Simpler source/sample path and applied playback parameters; confirm listen hints are omitted for `sample_setup_failed` or `partial_change`. Keep selection guard behavior unchanged.
- [ ] **Step 10: Run the production build and diff check.** Run `cd AIbleton/AIbleton && npm run build` and `git diff --check`. Inspect the occupied-source guard and confirm no instrument is inserted beside another primary source.
- [ ] **Step 11: Commit sample application.**

```bash
git add AIbleton/src/tools/soundrecipes.ts AIbleton/src/verify/rules.ts AIbleton/src/tools/listenhint.ts AIbleton/src/selectionguard.ts
git commit -m "feat: apply samples on empty instrument tracks"
```

If review confirms `verify/rules.ts`, `tools/listenhint.ts`, or `selectionguard.ts` need no edits, omit those unchanged paths from `git add`.

### Task 4: Route explicit sample requests and document the tool

**Files:**

- Modify `AIbleton/src/prompts.ts`
- Modify `AIbleton/src/chat/deleteauth.ts`
- Modify `AIbleton/src/tools/definitions.ts`

**Interfaces:**

- `systemPromptFor()` derives sample recipe lists from `SOUND_RECIPES` using both role and `source === "sample"`.
- `deleteAuthorizationFor(userText)` continues granting only the existing `sound_source` kind for explicit sample recipe actions.
- Tool schema enum continues to derive all supported IDs from `SOUND_RECIPE_IDS`.

- [ ] **Step 1: Add recipe group variables in `prompts.ts`.** Derive `padSampleRecipes`, `pluckSampleRecipes`, and `leadSampleRecipes` from the shared catalog; do not hardcode a second independent list of IDs.
- [ ] **Step 2: Add explicit-sample routing.** Explicit sample intent selects a sample counterpart after explicit timbre; explicit guitar/nylon/electric/muted guitar and kalimba/mbira/thumb piano retain `pluck_guitar` and `pluck_kalimba`. Use the approved genre fallbacks for each role. Without explicit sample intent, keep current synth routing.
- [ ] **Step 3: Add sample-specific source authorization words.** Extend the sample style/mode terms to recognize `sample`, `sampled`, `loop`, `one-shot`, `采样`, and `采样音色`; preserve the action requirement and negated destructive-action guard. Confirm this adds only `sound_source`, never generic `device` deletion.
- [ ] **Step 4: Generalize `apply_sound_recipe` documentation.** Explain the nine sample profiles, explicit-sample selection, Pad loop requirements, Pluck/Lead non-loop playback, declared synth fallback for missing samples, and refusal when required Pad Loop controls are unsupported.
- [ ] **Step 5: Verify result wording.** Ensure successful results include `source.playback_mode`; no-match fallback states the selected synth and reason; Pad loop-control failure says no source was replaced. Keep the existing “audition in Live” guidance.
- [ ] **Step 6: Preserve current Bass, synth Pad/Pluck/Lead, and named guitar/kalimba routing.** Review prompt precedence against the spec and ensure sample recipes never become implicit defaults.
- [ ] **Step 7: Run the production build, diff check, and final static review.** Run `cd AIbleton/AIbleton && npm run build` and `git diff --check`; review all four tasks against the Review Focus and Completion Criteria. Automated tests remain out of scope unless the user asks for them.
- [ ] **Step 8: Commit prompt, authorization, and documentation changes.**

```bash
git add AIbleton/src/prompts.ts AIbleton/src/chat/deleteauth.ts AIbleton/src/tools/definitions.ts
git commit -m "feat: route sampled pad pluck lead recipes"
```

## Completion Criteria

- All nine new sample recipes are available via the shared tool schema.
- The eleven Bass recipes, nine existing synth recipes, and two named-source sample Pluck recipes retain current behavior.
- Sample queries enforce all required filename evidence groups and playback markers using the filename stem.
- Pad samples use Simpler Classic + Loop On or fail before replacing the current source.
- Pluck/Lead sample recipes reject loop/phrase candidates and use a new Simpler with its default non-loop playback state.
- When a matching new sample recipe is selected, the target track must have no primary instrument; occupied tracks are refused before mutation.
- Explicit sample intent is required for the new sample profiles; missing samples use the declared synth fallback with a clear note.
- `npm run build` succeeds and `git diff --check` reports no whitespace errors.
