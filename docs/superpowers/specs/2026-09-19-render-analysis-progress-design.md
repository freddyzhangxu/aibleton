# Render analysis progress

## Goal

Show a native Live progress dialog while `analyze_rendered_track` renders and
analyses audio, with honest cancellation semantics.

## Design

Wrap only `analyze_rendered_track` in `context.ui.withinProgressDialog`.

Stages:

1. Start at 15%: rendering the requested arrangement range through Live.
2. Update to 70%: reading and analysing Live's temporary render output.
3. Resolve normally: the SDK closes the dialog automatically.

The existing web chat status/Stop UI remains unchanged.

## Cancellation

`renderPreFxAudio()` cannot be reliably interrupted by the public SDK. When
the user cancels, the callback records the abort signal, waits for any active
render to return, then skips file reading and DSP and returns a user-cancelled
error. No analysis result is produced and the Set is never changed.

## Scope and verification

- No progress dialog for other tools.
- No change to render output, ranges, feature calculations, or chat history.
- Unit-test callback stage ordering and cancellation-after-render behaviour
  with mocked UI/resources; manually verify the native dialog in Live.
- Run `npm exec tsc -- --noEmit` and `npm test`.
