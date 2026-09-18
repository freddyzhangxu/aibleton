# Right-click focus context

## Goal

When a user opens AIbleton from a Live context menu, retain the clicked Live
object as the current chat focus so that references such as “this clip” or
“this track” have a precise, current meaning.

## Scope

- Support the existing context-menu scopes: MIDI/Audio Track, Scene, MIDI/Audio
  Clip, and ClipSlot.
- Keep focus active for the current chat until the user opens AIbleton from a
  different object or opens it normally in a browser.
- Surface a compact focus summary in the system prompt on every chat turn.

## Design

`extension.ts` receives the context-menu command's first argument as a SDK
`Handle` and stores it as the active focus before showing the dialog. It clears
the focus when no valid handle was supplied.

`setcontext.ts` owns the stored handle. During `updateSetContext`, it resolves
the handle again through `context.getObjectFromHandle` and renders a compact
summary for the current prompt. The summary identifies the clicked object and,
where applicable, its track/scene coordinates, arrangement beat position,
duration, clip type, MIDI note count, or audio filename.

The resolver never trusts a stored object instance. If the handle no longer
resolves (for example because the object was deleted), it clears the focus and
omits the prompt section. Switching to a different Live Set also clears the
focus, since a handle from the old document must not target the new Set.

The normal browser-open endpoint clears focus before showing its dialog. This
prevents a stale right-click target from silently affecting a separately opened
chat.

The prompt describes focus as likely user intent, not authorization or a fresh
read. It instructs the model to obtain current Set/Clip state before any
mutation.

## Error handling

- Missing, malformed, deleted, or unknown handles are harmless no-ops: focus is
  cleared and chat continues without target context.
- Resolver errors never block a chat request.
- Focus is in memory only; it is not written to chat history or persistent
  settings.

## Verification

- Unit-test summaries for the six supported object categories.
- Unit-test clearing on a deleted handle, Set switch, and normal browser open.
- Unit-test prompt injection and absence after clearing.
- Run `npm exec tsc -- --noEmit` and `npm test`.
