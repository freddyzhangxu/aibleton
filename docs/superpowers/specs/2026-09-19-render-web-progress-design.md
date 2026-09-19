# Render analysis web progress

## Goal

Show reliable, visible render-analysis progress in AIbleton's existing web
chat UI, independent of the Extension Host's non-visible native progress UI.

## Design

Reuse the existing server `toolState.phase` → `/api/status` → 0.9-second web
polling path. Add two phase keys:

- `rendering`: Live is rendering the requested arrangement audio range.
- `analyzing_render`: the temporary render output is being read and analysed.

`analyze_rendered_track` sets `analyzing_render` immediately after
`renderPreFxAudio()` completes and before file I/O/DSP begins. The runtime sets
`rendering` when it dispatches the tool and restores `thinking` after it
returns, using its existing phase lifecycle.

Add localized strings for both phase keys in every current UI language. The
existing thinking bubble and Stop button remain the only UI elements; no new
API, component, persisted message, or cancellation path is added.

## Verification

- Unit-test the tool phase mapping and the post-render phase transition.
- Confirm every UI locale defines both labels.
- Run `npm exec tsc -- --noEmit` and `npm test`.
- In Live, start a long render analysis and observe both web-chat labels.
