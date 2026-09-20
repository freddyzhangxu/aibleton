# Goal-check diagnostics internationalization design

## Context

When a musical task declares a goal and the measured Live Set does not satisfy it, the server enters the goal gate. The normal model response may be English, but the goal-gate retry/final diagnostics currently contain hard-coded Chinese phrases such as `期望`, `实际`, `现有角色`, and `计划诊断`.

This is a deterministic server-side presentation problem, not provider language drift. It is reproducible for users in every country when a goal check fails, especially after `set_goal` + `set_plan` workflows.

## Objective

Localize the complete goal-check diagnostic chain to the active reply language:

- retry injection after the first failed goal check;
- final unmet-goal note after the retry budget is exhausted;
- measured pass note;
- plan execution/effect diagnosis;
- section verification;
- reference verification;
- generation refinement diagnostics.

The fix must cover the seven existing UI languages: Chinese, English, German, French, Japanese, Spanish, and Italian.

The goal evaluator must keep exactly the same pass/fail behavior and numeric measurements. Only human-readable diagnostic text changes.

## Non-goals

- Do not rewrite the goal vocabulary or success-criteria semantics.
- Do not change model prompts unrelated to language selection or music behavior.
- Do not clean up every Chinese string in the repository. Generic tool errors, web-search errors, schema warnings, logs, and UI copy are outside this focused change unless they are emitted as part of the goal-gate diagnostic chain.
- Do not translate user-authored goal objectives, track names, section names, role names, tool names, metric IDs, or provider/model output. These are data and must remain intact.

## Recommended architecture

Add a small goal-presentation localization module, e.g. `src/goal/i18n.ts`, with:

1. A supported reply-language type and normalizer.
   - Accept the existing two-letter language codes.
   - Treat `en`, `zh`, `de`, `fr`, `ja`, `es`, and `it` as supported.
   - Normalize unknown values to English at the user-facing goal-gate boundary, matching the system prompt's default language.

2. A phrase dictionary and formatting helpers for diagnostic concepts.
   - Headings and connective text: goal check, constraints, unmet criteria, plan diagnosis, unexecuted steps, unobserved effects, expected/actual, section check, reference check, refinement, and measured-state disclaimers.
   - Metric-specific labels used by `evaluateGoal` and `plan/check`: section, baseline, energy density, track count, role presence, unchanged content, tempo, key, audio features, generation record, increase/decrease, and unavailable data.
   - Formatting helpers must interpolate dynamic values without translating them.

3. Explicit language propagation from `goalGate`.
   - Normalize `req.language` once at the gate boundary.
   - Pass the normalized language to every goal diagnostic producer.
   - Keep the existing result object shapes (`GoalCheck`, `EffectCheck`, `PlanReport`, and section/reference verdicts) so the gate flow and tool loop remain stable.

The evaluator and plan checker will use the formatter helpers while constructing their existing `expected` and `actual` strings. This is intentionally smaller than converting every internal result into a new structured AST, but avoids brittle post-hoc replacement of Chinese strings.

## Data flow

```text
chat request language
        |
        v
goalGate -> normalizeGoalLanguage
        |
        +--> evaluateGoal(..., language)
        +--> buildPlanReport(..., language)
        +--> presentSectionVerification(..., language)
        +--> presentReferenceVerification(..., language)
        +--> goalRetry/goalUnmet/goalMet/refine formatter(..., language)
        |
        v
localized retry injection or final measured note
```

The actual Set measurements, criterion IDs, tool names, track names, section names, and user objective are not localized. Only surrounding explanatory text is localized.

## Compatibility decisions

- Public/pure evaluator helpers will retain an optional language parameter so existing offline fixtures and callers continue to compile.
- The user-facing goal gate always supplies an explicit normalized language; therefore an English UI cannot receive the old Chinese fallback merely because the request omitted a language field.
- Existing Chinese fixtures may continue to call helpers without a language and retain Chinese output for compatibility. New tests will exercise explicit `en` and at least one additional language.
- Existing bilingual slash labels may be replaced with one-language labels; the active language is the source of truth.

## Files expected to change

- `src/goal/i18n.ts` (new): language normalization, phrase dictionary, and formatting helpers.
- `src/goal/evaluate.ts`: accept/pass language in goal judges and replace hard-coded diagnostic labels with formatter calls.
- `src/plan/check.ts`: accept/pass language in effect judges/report assembly and localize plan-effect diagnostics.
- `src/agent/runtime.ts`: normalize language at the goal-gate boundary and localize retry, pass, unmet, refinement, plan, section, and reference messages.
- `src/music/sections/verify.ts`: localize section-verification presentation.
- `src/music/reference/present.ts`: localize reference-verification presentation.
- `src/genlog/suggest.ts`: localize generation-gap hints and refinement discipline text while preserving the embedded English prompt keywords.
- Existing goal/plan tests plus a new focused localization test file: assert representative output for all seven languages and assert English output has no CJK characters in the affected diagnostic paths.

No changes are expected in `ui/interface.html` for this bug because the server already sends the selected language on each request.

## Testing and acceptance criteria

1. Type-check and the existing test suite pass.
2. A failed English role/plan goal produces English diagnostics throughout, including the dynamic `expected` and `actual` portions.
3. The same representative failure produces the correct language for `zh`, `de`, `fr`, `ja`, `es`, and `it`.
4. English goal-gate output contains no Chinese characters in retry, final unmet, section, reference, plan, or generation-refine diagnostics.
5. Goal pass/fail booleans, criterion IDs, numeric values, and retry counts remain unchanged.
6. User-authored names and objective text are preserved byte-for-byte inside localized messages.
7. Missing/unknown language at the user-facing gate falls back to English.

## Rollout and verification

After implementation, run `npm test` and `npm run build` from `AIbleton/`. Review the generated test output for the exact screenshot scenario (`role_present` plus `role_audible` plan effects), then inspect the diff to confirm no unrelated Chinese strings or behavior were changed.
