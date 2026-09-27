# Vocal Assist v1 Design

**Status:** Draft for review  
**Date:** 2026-09-27

## Goal

Give users a focused workflow for improving an isolated vocal track with Ableton Live's built-in devices, using measurable audio cues where available and the user's listening judgment for sound quality.

## User and success

The primary user has a vocal audio track in a Live Set and asks AIbleton to make it clearer, more forward, or otherwise improve it. The user should be able to understand what AIbleton observed, see which devices and parameters it proposes to change, and audition the result in Live.

V1 succeeds when AIbleton can identify and inspect the requested vocal track, distinguish measured facts from tentative cues, make a small and reversible set of device changes aligned with the user's stated goal, and report what changed and what still needs listening.

## Existing capabilities and constraints

- `analyze_song` can decode source audio and report source-file features, including level range, near-full-scale sample share, 5–10 kHz sibilance candidates, low-frequency burst candidates, and coarse spectral balance.
- Those vocal cues are screening measurements. They are not diagnoses of clipping, sibilance, plosives, pitch accuracy, or perceived clarity.
- Source-file analysis is pre-warp, pre-gain, and pre-device. `analyze_rendered_track` renders arranged audio pre-FX, so it does not measure the track's device-chain output.
- AIbleton can inspect, insert, and set parameters on built-in Live devices. Device parameter names and ranges should be read from Live rather than assumed.
- Live 12.1 introduced Auto Shift. Pitch correction is outside the default clarity/forwardness workflow and must only be used when requested.

## V1 experience

1. The user names a vocal track or asks to optimize the vocal. AIbleton resolves the track from the current Live Set and checks that it is an audio track.
2. AIbleton reads the track's clips, current device chain, and relevant device parameters. When source audio is available, it runs vocal-focused audio analysis and labels all results as measurements or screening cues.
3. AIbleton maps the user's stated goal to a conservative processing proposal. For clarity/forwardness, it may use EQ Eight and Compressor as starting options. Gate, saturation, reverb, and pitch correction are not inserted by default.
4. AIbleton applies only changes that directly serve the user's request, using built-in devices and values/ranges discovered from Live. Existing devices should be adjusted before adding duplicates when a suitable device is already present.
5. AIbleton reports which devices and parameters changed, what evidence informed the choices, what remains uncertain, and asks the user to audition the result. The user can request another adjustment in ordinary language.

## Behavior boundaries

- Do not invent specific frequency problems, pitch-stability results, or perceptual diagnoses from broad-band measurements.
- Do not claim the post-processing sound was analyzed or verified in V1. The user audition is the quality feedback loop.
- Do not add Auto Shift unless pitch correction is explicitly requested. Do not claim that the vocal's correct target scale has been detected unless an independent analysis provides that evidence.
- Do not add a fixed chain to every vocal. Device selection and settings depend on the user's requested outcome and the observed signal.
- Preserve existing processing where possible. Make a focused, undoable change; do not delete or replace existing devices as a routine optimization step.
- If the target is ambiguous, not an audio track, has no readable source audio, or has an unsupported configuration, explain the limit and ask for the missing information or offer a safe next step.

## Processing and feedback model

The initial workflow is human-in-the-loop:

```text
Resolve vocal track → Inspect chain and source cues → Propose/apply focused edits → User auditions → Refine on request
```

The system must make clear that source-file measurements do not include existing device processing. Until a post-FX measurement path exists, do not compare pre-change source measurements with a claimed post-change result.

## Feasibility probe: post-FX measurement

Before or alongside implementation planning, investigate whether the supported Ableton Extensions SDK and current AIbleton runtime can obtain an audio render that includes a track's device chain without requiring unsafe Set mutations or external recording. The probe should answer:

- Can the runtime render a selected audio track through its FX chain?
- Can it isolate the target track while preserving relevant timing and automation?
- What are the latency, resource, and Live-version constraints?
- Can the measurement be repeated safely without changing the user's Set?

The probe is not a V1 release blocker. If it is not feasible at acceptable cost, V1 remains human-in-the-loop and reports that limitation plainly. A later post-FX loop requires a separate design decision.

## Out of scope for V1

- AI denoising, de-reverberation, de-plosive repair, declipping, source separation, or voice enhancement services.
- Uploading vocal audio to an external processing service.
- Automatic pitch detection/correction or key detection specifically for vocal tuning.
- Guaranteed de-essing or exact sibilance-frequency localization.
- Automatic loudness normalization or mastering.
- Background processing that changes a track without a user request.

## Acceptance criteria

1. Given a named audio track with readable clips, the workflow inspects the current track and its device chain before proposing edits.
2. The workflow reports only measurements exposed by the current analysis and describes heuristic vocal cues as candidates, not confirmed defects.
3. A clarity/forwardness request does not automatically add pitch correction, denoising, reverb, or a fixed multi-device chain.
4. Device parameters are resolved from Live's current parameter metadata; unknown devices or parameters do not produce guessed values.
5. Changes are scoped to the requested track and can be undone through Live's normal undo behavior.
6. The completion message identifies edits made and asks the user to audition; it does not claim post-FX verification.
7. Ambiguous targets, MIDI tracks, unavailable audio sources, and unsupported device operations result in a clear explanation without unrelated Set changes.

## Decisions for this review

- V1 is a guided native-device workflow with user audition as the feedback loop.
- Processing-after-effect measurement is a feasibility probe and a possible later phase, not a V1 promise.
- External AI audio repair and automatic vocal tuning are explicitly deferred.

## Self-review

- **Coverage:** Goal, user, success, existing capabilities, interaction flow, boundaries, failure cases, feasibility probe, exclusions, and acceptance criteria are specified.
- **Consistency:** The workflow uses current source-file cues but does not claim those cues describe post-FX audio; post-FX measurement is deferred.
- **Scope:** V1 is one user-facing workflow over existing analysis/device-control capabilities. External audio services and a new post-FX analysis subsystem are excluded from the release scope.
- **Ambiguity:** “Improve vocal” is open-ended, so the design requires the agent to derive a focused action from the user's stated outcome and avoid a fixed chain. Exact processing presets and parameter heuristics are implementation-plan decisions constrained by live parameter introspection and user audition.
- **Evidence:** Existing repository behavior was checked in `AIbleton/src/dsp.ts`, `AIbleton/src/audiofiles.ts`, `AIbleton/src/tools/definitions.ts`, and `AIbleton/src/tools/dispatcher.ts`. Auto Shift availability is grounded in Ableton Live 12 release notes and the Live 12 manual.
