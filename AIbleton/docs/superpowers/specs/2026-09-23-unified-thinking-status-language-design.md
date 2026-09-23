# Unified Thinking Status Language Design

## Context

After a user sends a command, the UI shows a generic progress message while the server has not reported a more specific phase. These messages currently translate both the thinking-status words and the note that the window may be closed while the task continues in the background.

The requested behavior is:

- Generic thinking-status words are always English in every supported UI language.
- The background-task note remains localized to the selected UI language.
- Specific phases such as reading the Live Set, analyzing the arrangement, and generating audio keep their existing translations.

## Goals

1. Show the same English generic status vocabulary in all languages: `Thinking…`, `Pondering…`, and `Mulling…`.
2. Preserve localized background-task guidance, including the existing meaning that the window can be closed and the task continues.
3. Preserve the existing five-second rotation, language-switch behavior, and server-side background-task behavior.
4. Limit the change to the UI display layer.

## Non-goals

- Do not change `phase_reading`, `phase_analyzing`, `phase_rendering`, `phase_generating`, `phase_applying`, `phase_planning`, or `phase_searching` translations.
- Do not change task execution, polling, cancellation, window closing, or AI prompts.
- Do not change the supported language list or the meaning of any localized text.

## Design

### Data model

In `ui/interface.html`, split the generic thinking message into two independently localized parts:

1. A single shared English status-word list used by every language.
2. A per-language background-task note, localized according to `currentLang`.

The existing `genericThinkingLabel()` remains the composition point. It selects the current English status word by rotation index and appends the localized note. `t('thinking')` and the current `THINKING_VARIANTS` data are replaced or reorganized so no locale can introduce translated status words.

### Runtime behavior

- When the server reports no specific phase, the UI rotates through the English generic status words every five seconds.
- When the server reports a specific phase, the UI continues to use the existing localized `phase_*` message.
- When the user changes language while a generic status is visible, the English status word stays unchanged and only the localized background-task note is re-rendered.
- When the generic status disappears, the existing timer cleanup and state reset behavior remains unchanged.

### Error handling and compatibility

No new runtime error path is introduced. A missing locale-specific note should fall back to the English note, matching the existing i18n fallback convention. Existing status rendering must continue to work for the native bar, Live dialog, and reopened windows because the change is entirely within the shared UI file.

## Verification

1. Add a focused static or unit-level check covering all seven supported languages:
   - generic status words are exactly the shared English vocabulary;
   - every language has a non-empty localized background-task note.
2. Run the TypeScript build/type check.
3. Run the existing test suite.
4. Build the UI and verify the generated artifact is produced successfully.
5. Manually inspect the rendered combinations for at least English and Chinese, plus one non-English locale, if the local UI harness is available.

## Acceptance criteria

- In Chinese, German, French, Japanese, Spanish, and Italian, generic progress messages use `Thinking…`, `Pondering…`, or `Mulling…` rather than translated equivalents.
- The parenthetical note is localized for the active UI language.
- Specific phase messages remain unchanged from their current localized behavior.
- Existing rotation, language switching, closing/minimizing, polling, and background execution behavior are unaffected.
- Type checking, tests, and the UI build pass.
