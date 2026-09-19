# Safe Markdown Rendering for AI Replies

## Goal

Render the common Markdown that model providers return in AIbleton assistant
messages. Today `ui/interface.html` assigns every message through
`textContent`, so syntax such as `**bold**`, lists, and fenced code blocks is
visible literally.

The change applies only to assistant replies. User messages, errors, thinking
status, tool logs, history labels, and other UI-generated strings remain plain
text.

## Chosen approach

Implement a small, dependency-free renderer in `ui/interface.html`. It will
parse a deliberately bounded Markdown subset and build DOM nodes rather than
assigning model output to `innerHTML`.

This keeps the extension bundle small and avoids depending on an external
Markdown library in Ableton's embedded webviews. It also makes the safety
boundary explicit: unrecognized input stays visible as escaped text.

## Supported syntax

Block-level syntax:

- ATX headings (`#` through `###`)
- Paragraphs and blank lines
- Unordered lists (`-`, `*`, `+`) and ordered lists (`1.`)
- Block quotes (`>`)
- Horizontal rules (`---`, `***`, `___`)
- Fenced code blocks (triple backticks, with an optional language label)

Inline syntax:

- Bold (`**text**` and `__text__`)
- Italic (`*text*` and `_text_`)
- Strikethrough (`~~text~~`)
- Inline code (single backticks)
- Markdown links (`[label](https://...)`)

Nested formatting is supported for the normal combinations used in AI replies.
Images, tables, HTML, task lists, and arbitrary URL auto-linking are out of
scope for this focused first version.

## Architecture and data flow

`renderMessages()` already reconstructs both newly completed and persisted
chat messages through `addMsg()`. `addMsg()` will select its rendering mode by
message class:

1. For an assistant reply (`ai`), clear the bubble and call
   `renderMarkdown(text, container)`.
2. The renderer tokenizes block constructs first, then builds corresponding
   DOM elements.
3. Normal text inside each block passes through an inline parser that appends
   text nodes and a fixed, allowlisted set of semantic elements.
4. For every other message class, retain the existing `textContent` path.

Because DOM nodes are constructed with `createElement` and `textContent`, model
responses can never supply markup, event handlers, styles, or executable URLs.

## Link handling

Links are only emitted for `https:`, `http:`, and `mailto:` destinations.
Every other destination, including `javascript:` and data URLs, remains literal
text. Accepted links open in a new browsing context with `rel="noopener
noreferrer"`; the host webview retains control over whether that context is
available.

## Presentation

Add scoped `.msg.ai` rules for readable headings, lists, quotes, horizontal
rules, inline code, fenced code, and links. The styles use existing AIbleton
color variables and constrain long code blocks to vertical scrolling rather
than changing the chat layout.

The existing `.msg` `white-space: pre-wrap` rule will be overridden only where
necessary inside assistant Markdown blocks so paragraphs and lists use normal
document flow while code preserves whitespace.

## Error handling and compatibility

Malformed or unmatched Markdown delimiters are emitted as ordinary text; a
single malformed response cannot break the rest of the chat bubble. An
unclosed code fence renders the remaining lines as code. The implementation
uses browser APIs available in the supported embedded WebView environments and
introduces no network requests or runtime dependencies.

## Verification

Add focused tests for the pure Markdown parsing/rendering helper where the
project's current UI test setup permits it; otherwise cover it with an
executable browser-free fixture test. Verify at minimum:

- all supported block and inline constructs render into the intended tags;
- ordinary text and unmatched delimiters remain text;
- HTML-like model output does not create DOM elements;
- unsafe link schemes are not clickable;
- assistant history and freshly finished messages use the same output;
- user and error bubbles still show their content literally.

Run TypeScript validation and the existing test suite after implementation.
