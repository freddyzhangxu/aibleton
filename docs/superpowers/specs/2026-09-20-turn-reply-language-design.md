# Turn-scoped reply language design

## Context

AIbleton currently uses one `language` value for several different concerns: panel localization, model reply guidance, web-search locale, server diagnostics, and provider errors. The client sends the panel language, but the server overwrites it with Ableton Live's UI language before dispatching the request.

The model prompt separately says to reply in the language the user writes. This creates two competing language authorities:

- the model often follows the latest user message;
- deterministic server/tool text follows the Live/UI language or a hard-coded Chinese/English fallback.

The result can be a Spanish model response with English or Chinese diagnostics, even in a new session.

## Objective

Make every user-visible response in a turn use one resolved `replyLanguage`.

The precedence is:

```text
latest user-message language
  -> AIbleton panel language when detection is uncertain
  -> English when the panel language is missing or unsupported
```

Ableton Live's UI language must not override the reply language.

The supported languages remain `zh`, `en`, `de`, `fr`, `ja`, `es`, and `it`.

## Language concepts

The implementation must keep these concerns separate:

- `uiLanguage`: language selected in the AIbleton panel; controls HTML/UI copy and is the fallback for ambiguous input.
- `replyLanguage`: language resolved once for the current user turn; controls all model-facing and user-visible server/tool text.
- `searchLanguage`: locale used by web tools. It defaults to `replyLanguage`, so search results align with the user's current language.
- `liveLanguage`: Ableton Live's own UI language. It may be used only as an initial UI default when no AIbleton preference exists; it does not participate in per-turn reply resolution.

## Reply-language resolution

Add `src/i18n/language.ts` with a deterministic resolver:

```ts
type SupportedLanguage = "zh" | "en" | "de" | "fr" | "ja" | "es" | "it";

interface ResolveReplyLanguageInput {
  text: string;
  panelLanguage?: string;
}

interface ResolvedReplyLanguage {
  language: SupportedLanguage;
  source: "message" | "panel" | "default";
  confidence: number;
}
```

Resolution rules:

1. Analyze only the raw current message, before attachment summaries or machine-generated labels are appended.
2. Ignore URLs, code fences, file paths, numbers, tool names, and common music tokens such as BPM/key names when scoring language.
3. Detect Chinese and Japanese by script first. Japanese kana wins over shared Han characters; Han-only text resolves to Chinese.
4. Score English, German, French, Spanish, and Italian using normalized word tokens, language-specific stop words, characteristic suffixes, and diacritics.
5. Require a minimum amount of linguistic evidence and a clear margin over the second-best language.
6. For text with no reliable linguistic evidence, such as `120 BPM`, a single track name, or a filename, use `panelLanguage`. A short but clearly linguistic phrase such as `Kick harder` may resolve to English.
7. For genuinely mixed text, use the dominant natural-language token score. A tie falls back to the panel language.
8. Unsupported/missing panel languages fall back to English.

The resolver is pure, local, deterministic, and adds no provider call, latency, or cost.

## Turn language context

Introduce one turn-scoped value after the request body is parsed:

```ts
interface TurnLanguageContext {
  uiLanguage: SupportedLanguage;
  replyLanguage: SupportedLanguage;
  searchLanguage: SupportedLanguage;
  source: "message" | "panel" | "default";
}
```

The server creates this context before the user message is enriched with attachments and before provider dispatch. `toolState.activeLanguage` becomes the resolved `replyLanguage` for compatibility with existing tools during migration.

The current server overwrite is removed:

```ts
// Remove from the per-turn path:
if (live) parsed.language = live;
```

Provider request objects receive `replyLanguage`, not `liveLanguage` or the raw panel value.

## Data flow

```text
raw user text + panel language
              |
              v
     resolveReplyLanguage
              |
              v
     TurnLanguageContext
       |        |       |
       v        v       v
   providers  tools   web locale
       |        |
       +----+---+
            v
   localized final reply
```

The resolved language remains fixed for the whole turn, including retries and background execution. A later user message resolves a fresh language.

## Centralized localization

Expand the existing goal-diagnostic localization into a general `src/i18n/` boundary:

```text
src/i18n/
  language.ts
  index.ts
  common.ts
  errors.ts
  tools.ts
  web.ts
  audio.ts
  goal.ts
```

Each catalog is a compile-time-complete `Record<SupportedLanguage, ...>`. Missing keys fail TypeScript compilation; known languages never silently fall back to Chinese or another supported language.

User-visible modules call a typed formatter:

```ts
t(replyLanguage, "tool.track_not_found", {
  name: trackName,
  available: availableTrackNames,
});
```

User-authored values, track names, section names, filenames, provider names, tool names, and metric IDs are interpolated unchanged.

## Error boundary

Introduce a structured error for deterministic application failures:

```ts
class AppError extends Error {
  code: ErrorCode;
  params: Record<string, string | number | string[]>;
}
```

Core/tool code throws error codes and parameters instead of prose. Localization happens only at a user-facing boundary:

- provider failure -> localized `lastError`;
- tool failure -> localized tool result for the model;
- HTTP validation failure -> localized API/UI error;
- verification failure -> localized diagnostic;
- unknown internal error -> raw details go to debug logs, while the user receives a localized generic error plus a stable error code.

This prevents a Chinese SDK/tool exception from being copied verbatim into a Spanish response while preserving debugging detail in logs.

## Model prompting

Keep the main system prompt canonical and add one explicit per-turn instruction near the end:

```text
Reply language for this turn: Spanish (es).
Use Spanish for all user-facing prose.
Do not imitate the language of tool results, error payloads, track names, or attached content.
```

Remove Chinese-only labels and examples from generic instructions where an English/schema-based example communicates the same rule. Attachment markers become language-neutral machine labels such as `<attachment name="...">` and `<image name="...">`.

The model remains responsible for natural-language generation, but deterministic server text no longer depends on model compliance.

## Migration order

### Phase 1: language authority

- Add the resolver and `TurnLanguageContext`.
- Stop Live language from overwriting the panel language.
- Pass `replyLanguage` to all providers, the goal gate, active tool state, and web locale.
- Add explicit per-turn model language instructions.

### Phase 2: direct user-visible surfaces

- Localize provider/API errors for all seven languages.
- Localize empty-response fallback in all four providers.
- Localize stop/truncation, busy/empty-message/session errors, confirmation denial, and verification failure.
- Reuse the already-localized goal/plan/section/reference chain.

### Phase 3: tool and subsystem errors

- Migrate selection guard, goal/plan normalization warnings, tool helpers/dispatcher, web search, audio generation, Move operations, arrangement, warp, Drum Rack, and Take Lane errors to `AppError` codes.
- Keep raw provider/SDK errors in debug logs only.

### Phase 4: prompt and context hygiene

- Replace Chinese attachment/context wrappers with machine tags.
- Remove language-specific examples from the generic system prompt where practical.
- Add a repository check preventing new user-visible literal strings outside localization catalogs.

## Compatibility

- Existing session messages are not rewritten.
- Existing UI language selection remains unchanged and becomes the ambiguity fallback.
- Existing provider and tool interfaces continue accepting a `language` string during migration; internally it represents `replyLanguage`.
- The current goal-diagnostic localization remains valid and moves behind the shared language type/catalog without changing goal semantics.
- No new runtime dependency or network call is required for detection.

## Testing

### Resolver tests

- Clear samples for all seven languages.
- Spanish text + English panel + German Live -> Spanish.
- Ambiguous `120 BPM` + Spanish panel -> Spanish from panel fallback.
- Japanese kana + Han -> Japanese; Han-only -> Chinese.
- URLs, code, filenames, model names, track names, and key names do not dominate detection.
- Mixed-language inputs resolve by dominant score; ties use panel language.

### End-to-end language matrix

For every supported language, exercise:

- normal text response;
- goal pass and goal failure;
- plan, section, and reference diagnostics;
- tool validation and postcondition verification failure;
- API 401, 429, quota, network, and unknown errors;
- empty provider response;
- stop and truncation notes;
- web-disabled/search/fetch errors;
- audio-generation errors;
- selection-guard rejection.

For Spanish, German, French, Italian, and English fixtures, assert that deterministic output contains no unexpected Han/Kana characters when user-authored values contain none. Also assert a locale-specific marker so passing by empty output is impossible.

### Regression checks

- Tool names, track names, filenames, numbers, and metric IDs are unchanged.
- Reply-language resolution runs once per turn and remains stable across retries.
- `npm test`, `npm run build`, and focused language-matrix tests pass.

## Acceptance criteria

1. A Spanish message produces Spanish user-visible text even when the AIbleton panel is English and Ableton Live is German.
2. An ambiguous message uses the AIbleton panel language.
3. No per-turn code path overwrites `replyLanguage` with Live's language.
4. Every deterministic user-visible string in the migrated paths is generated from a seven-language compile-time-complete catalog.
5. Raw internal errors never appear directly in the UI or final assistant response.
6. Existing music-operation behavior, goal evaluation, and tool execution semantics are unchanged.
