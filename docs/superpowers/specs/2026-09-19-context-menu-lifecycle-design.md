# Context Menu Registration Lifecycle

## Problem

Ableton Live's development Extension Host can call the extension's `activate`
entry point more than once. Each activation currently registers the same
context-menu actions and discards the SDK-provided unregister callbacks, so a
right-click menu can show duplicate `AIbleton: Open` items even when only the
development extension is loaded.

## Goal

Make context-menu registration idempotent across repeated activation in the
same Extension Host. A new activation must replace its predecessor's actions,
not accumulate another copy.

## Design

Maintain one module-process-wide registry on `globalThis`, keyed with a unique
symbol. The registry stores:

- the latest list of SDK unregister callbacks; and
- a Promise tail that serializes lifecycle work.

On every activation, enqueue this sequence on the Promise tail:

1. Take and clear the prior unregister callback list.
2. Invoke every prior callback, allowing all cleanup attempts to settle.
3. Ignore an individual cleanup rejection because the Host may already have
   removed that action during a reload.
4. Register every current menu scope and save the returned callbacks as the
   new registry state.

The first activation has an empty cleanup list and simply registers the
actions. Serializing the sequence prevents two closely-spaced activations from
interleaving cleanup and registration.

The command registration and HTTP server startup remain unchanged. The fix is
limited to UI context-menu registrations; it does not try to unload another
Extension Host or installed extension.

## Error Handling

Registration failures are logged per scope and do not prevent later scopes
from registering. A cleanup failure is logged at debug/warn level and does not
block the new action set. The stored cleanup list contains only successful new
registrations.

## Testing

Extract the small registration lifecycle into a testable helper. Unit tests
will verify:

1. First registration creates one action per scope.
2. A second registration calls every old cleanup before it creates new actions.
3. Concurrent calls serialize rather than duplicate actions.
4. A rejected cleanup does not prevent new registration.

Production TypeScript compilation and the full existing test suite remain
required.

## Non-Goals

- Do not add title-based host-side de-duplication; the SDK exposes no reliable
  query for already registered actions.
- Do not alter modal-dialog, command, server, or menu scope behavior.
- Do not remove user-installed extensions or stop separate development hosts.
