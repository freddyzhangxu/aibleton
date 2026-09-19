# User-facing track ordinals

## Goal

Prevent the zero-based `track_index` used by AIbleton's tools from leaking into
user-facing conversation, confirmations, and action summaries.

## Design

The system prompt will establish two distinct conventions:

- `track_index` remains a zero-based, internal tool coordinate. It must be
  paired with the current track name when calling a track tool.
- In all user-facing prose, the assistant refers to a track by its one-based
  ordinal and name: `第 1 轨（Drums）` in Chinese, or `Track 1 (Drums)` in
  English. It must not describe that target merely as `track 0`, `track 1`, or
  another raw internal index.

Natural-language ordinals map accordingly: "第一轨" / "first track" resolves to
the track whose internal `track_index` is `0`.

No tool schemas or dispatch behavior changes. Existing tool results can retain
`track_index` for agent coordination, debugging, and verification. The
assistant's response layer is responsible for translating those values before
they reach the user.

## Verification

- Add prompt-level regression assertions for the one-based user-facing rule,
  the zero-based internal-coordinate rule, and the ordinal mapping example.
- Run TypeScript type-checking and the complete test suite.
