# Browser open clears right-click focus

## Goal

Opening or refreshing AIbleton directly in a browser must clear any transient
right-click target from a previous Live context-menu invocation.

## Design

The HTTP server already treats `GET /` and `GET /index.html` as the browser UI
entry points. Before returning the HTML for either route, it will call the
existing `clearRightClickFocus()` function.

The context-menu command does not use either route, so opening AIbleton from a
right-click retains its newly supplied focus. `GET /api/open` continues to
clear focus because it is also a non-context-menu entry point.

## Error handling and scope

Clearing only resets in-memory prompt context. It does not change the Live Set,
chat history, or persisted settings. No UI changes or new HTTP endpoints are
needed.

## Verification

- Add a focused server-route test showing that both browser entry URLs clear a
  populated right-click focus before returning HTML.
- Run `npm exec tsc -- --noEmit` and `npm test`.
