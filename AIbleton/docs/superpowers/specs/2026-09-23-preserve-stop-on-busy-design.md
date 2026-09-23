# Preserve Stop Control When a Concurrent Send Is Rejected

## Context

The chat UI allows a second instruction to be submitted while the first task is
still running. The server correctly rejects the second request with HTTP 409
and a localized busy message, but the client handles that response as a generic
send failure and resets the button to Send. The first task is still running, so
the user loses the only Stop control.

## Goals

1. Keep the Send button in its Stop state while the original server-side task
   is still running.
2. Preserve the rejected second instruction in the input box so it can be sent
   after the active task finishes.
3. Keep the existing localized busy error message from the server.
4. Preserve the current behavior for all other request failures.

## Non-goals

- Do not queue or execute concurrent chat tasks.
- Do not change server-side busy detection, cancellation, or status polling.
- Do not change the wording or localization of the busy message.
- Do not change behavior for a task that was accepted and later fails.

## Design

The UI will snapshot the submitted text and attachments before clearing the
input. If `/api/chat` responds with HTTP 409, the client will treat it as a
server-side busy conflict: it will keep the current busy/Stop state, restore
the submitted text to the input and draft storage, and surface the existing
error message. For other errors, the current generic error path remains in
place and the button returns to Send.

Because the original task remains owned by the server, the existing
`/api/status` polling continues to be the source of truth and will switch the
button back to Send only after that task finishes or stops.

## Verification

1. Add a focused static/unit-level check for the busy-conflict branch and
   input restoration behavior.
2. Run the TypeScript type check and existing test suite.
3. Build the extension successfully.
4. Manually verify: start a long task, submit a second instruction, confirm the
   busy message appears, the second instruction remains in the input, and Stop
   still cancels the first task.

## Acceptance criteria

- A second instruction rejected with HTTP 409 does not remove the Stop state.
- The rejected instruction is available in the input box after the error.
- The user can click Stop and cancel the first task.
- Once the first task ends, normal polling changes the button back to Send.
- Non-409 failures retain the existing reset behavior.
