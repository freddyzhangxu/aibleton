# Detect Mixed-Language Final Replies

## Context

The Codex provider already asks for the user's resolved reply language and can
rewrite one final response when the response language is wrong. The current
detector classifies the whole reply as Japanese as soon as it finds any kana.
Consequently, a reply whose first sentence is Japanese but whose later prose
is Chinese is accepted without correction.

## Goals

1. Detect a meaningful language switch inside a final reply, especially
   Japanese prose followed by Chinese prose.
2. Trigger the existing bounded language rewrite for the expected turn
   language.
3. Keep the correction provider-agnostic so Codex, Claude, Gemini, and Custom
   benefit from the same behavior.
4. Avoid false positives from short labels, track names, code, URLs, numbers,
   and ordinary Japanese kanji-only fragments.

## Non-goals

- Do not add a second Codex-specific prompt or unconditional rewrite request.
- Do not change turn-language resolution for user messages.
- Do not change localized server-generated diagnostics or tool results.
- Do not change the one-correction limit per provider turn.

## Design

Keep the existing whole-reply mismatch check, then inspect meaningful sentence
and paragraph segments when the whole reply appears to match the expected
language. Each segment is passed through the existing resolver. A segment only
counts when it contains enough prose to be meaningful; short fragments and
code-like or numeric content are ignored. If a meaningful segment resolves to
a different language with sufficient confidence, `replyNeedsLanguageCorrection`
returns true.

For Japanese, this catches a Chinese segment containing Han characters but no
kana after a Japanese segment, while ordinary Japanese segments continue to be
recognized as Japanese. The provider loops remain unchanged and still append a
single language-correction prompt, capped by their existing counter.

## Error handling and compatibility

Language detection remains best-effort. Ambiguous or too-short segments fall
back to the expected language and do not trigger a rewrite. Existing behavior
for clearly wrong whole replies is preserved.

## Verification

1. Add unit coverage for pure Japanese, Japanese followed by Chinese, pure
   Chinese, short mixed fragments, and the existing clear mismatch cases.
2. Run the full TypeScript test suite.
3. Run the TypeScript type check and production build.

## Acceptance criteria

- A mixed reply such as Japanese prose followed by a substantial Chinese
  paragraph triggers the existing Japanese rewrite path.
- A fully Japanese reply does not trigger correction.
- A fully Chinese reply requested in Japanese still triggers correction.
- Short labels, code, URLs, numbers, and track names do not trigger a false
  correction by themselves.
- No provider loop performs more than one language rewrite in a turn.
