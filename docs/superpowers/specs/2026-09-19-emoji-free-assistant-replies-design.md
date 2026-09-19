# Emoji-Free Assistant Replies

## Goal

Ensure every AI chat reply shown or retained by AIbleton contains no Emoji.
The rule applies to assistant replies only. It does not alter user messages,
tool/action logs, status controls, or other interface labels that intentionally
use icons.

## Chosen approach

Use two layers:

1. Add a direct rule to the shared system prompt: assistant replies must not
   use Emoji.
2. Enforce the rule at the server-side assistant-message boundary, immediately
   before a reply is stored and returned to the UI.

The prompt steers providers toward clean prose; the server-side safeguard makes
the result provider-independent and covers replies produced by stop, retry, or
goal-gate paths. UI-only hiding was rejected because it would leave Emoji in
persisted chat history and the next provider context.

## Architecture and data flow

`src/prompts.ts` supplies one system prompt to every chat provider. Its rules
will state that user-facing replies must contain no Emoji.

`src/chat/session.ts` owns the single persisted assistant-reply path through
`finishChat()`. A small exported `stripEmoji()` helper will normalize a reply
there before it is added to `session.messages`, returned to the provider, and
saved to disk. This gives all Claude, Codex, Gemini, and custom-provider final
answers identical enforcement without changing individual provider adapters.

When existing sessions are loaded, assistant messages are passed through the
same helper. If any stored message changes, the cleaned session store is saved
once, so historical replies no longer reintroduce Emoji into the UI or model
conversation history. User messages remain byte-for-byte unchanged.

## Emoji recognition

The helper removes complete Unicode Emoji sequences, including ordinary
pictographs, presentation selectors, skin-tone modifiers, zero-width-joiner
sequences, flags, and keycap Emoji. It intentionally does not use a broad
"symbol" filter: musical notation, punctuation, Chinese/Japanese text, and
ordinary digits must remain intact.

Whitespace is not collapsed after removal. This preserves intentional line
breaks and avoids rewriting the model's prose beyond the prohibited glyphs.

## Error handling and compatibility

The helper accepts any string and never throws. It uses Unicode property escapes
available in the project's Node 24 runtime. If an unusual non-Emoji symbol is
not recognized as an Emoji sequence, it remains visible rather than risking
content loss. The UI continues to render stored strings normally and needs no
new behavior.

## Verification

Add focused unit tests for `stripEmoji()` covering plain text, common Emoji,
skin tones, joined sequences, flags, keycaps, variation selectors, and normal
symbols/digits that must survive. Add a session-path test confirming that
`finishChat()` stores and returns a sanitized assistant reply while leaving a
user message unchanged. Run the full test suite and production build.
