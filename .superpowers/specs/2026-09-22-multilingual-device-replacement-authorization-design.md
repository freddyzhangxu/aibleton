# Multilingual Device-Replacement Authorization

## Problem

The per-turn destructive-operation gate is intended to allow a direct replacement
of a named device to delete only that source device. In practice, the parser
recognizes only a partial list of built-in device names and only English and
Chinese replacement wording. For example, `删除 Track 3（Bass）的 Analog，并换成该采样`
contains an explicit source device and replacement instruction, but `Analog` is
not in the current device-name pattern, so `delete_device` is refused.

## Goal

Authorize the device deletion needed by an explicit, named device replacement
across common languages, while continuing to refuse vague replacement requests,
negated requests, and requests to delete other object kinds.

## Design

Keep authorization kind-scoped and per-turn. Extend the existing parser with two
small, independently testable matchers:

1. A known built-in Live device-name matcher covering every device name that
   AIbleton advertises for insertion or replacement, including `Analog`,
   `Drift`, `Meld`, `Collision`, and `Tension` in addition to the existing
   instruments and effects.
2. A multilingual direct-replacement matcher covering the existing English and
   Chinese forms plus common equivalent forms in Spanish, French, German,
   Portuguese, Italian, Japanese, and Korean. The matcher must require a
   replacement verb and a target/replacement relation; it must not grant
   permission from a generic “change the sound” request.

The authorization rule remains:

- An explicit delete verb plus a device-kind signal authorizes device deletion.
- A named known device plus a direct replacement signal authorizes device
  deletion and `replace_device` only.
- Track, scene, arrangement-clip, and session-clip permissions are derived only
  from their own explicit object-kind delete wording.
- Existing negation detection remains a hard veto. Add equivalent common
  negation forms for the supported replacement languages so “do not replace”
  cannot authorize a destructive tool.

The parser does not attempt to infer arbitrary third-party plugin names from
free text. Such names must be accompanied by an explicit device noun and delete
wording, or the request remains blocked for clarification.

## Data Flow

The chat turn continues to derive `toolState.activeDeleteAuthorization` once
from the current user message. No tool schema, dispatcher transaction, or
replacement workflow changes. For a sample swap, the model can therefore run
the existing verified sequence: overview → sample search → delete the named
source device → load the sample → verify the Simpler sample.

## Error Handling

If the message is vague, negated, names no supported device, or only asks for a
new sound without a replacement relation, the authorization set remains empty
for device deletion. The dispatcher returns the existing localized
authorization-required result and performs no mutation.

## Testing

Add unit coverage for:

1. The reported Chinese `Analog` sample-replacement wording.
2. All newly advertised built-in device names in at least one direct
   replacement form.
3. Representative English, Chinese, Spanish, French, German, Portuguese,
   Italian, Japanese, and Korean replacement requests.
4. Representative negated forms in multiple languages.
5. Vague “make it a better/new sound” wording and replacement wording without a
   recognized device name.
6. Continued separation from track, scene, and clip deletion authorization.

The TypeScript build and full existing test suite remain required.

## Non-Goals

- Do not weaken authorization for deleting tracks, scenes, or clips.
- Do not make replacement authorization depend on a second confirmation turn.
- Do not add arbitrary natural-language device-name extraction for unknown
  third-party plugins.
- Do not change the delete-first replacement transaction or sample-loading
  verification behavior.
