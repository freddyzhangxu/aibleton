# Vocal Assist v1 Design

**Status:** Draft for review  
**Date:** 2026-09-27

## Goal

Give users a focused workflow for comparing a recorded vocal with an isolated reference vocal and improving the recorded vocal with Ableton Live's built-in devices. Use measurable audio cues where available, and the user's listening judgment for sound quality and pitch-correction decisions.

## User and success

The primary user has recorded a vocal (for example, a cover) in a Live Set and wants to compare it with the original vocal, improve its sound, or request pitch correction. The reference may be a supplied isolated vocal file or a vocal stem the user created with Live's Stem Separation. The user should understand what AIbleton observed, see which devices and parameters it proposes to change, and audition both the comparison and the result in Live.

V1 succeeds when AIbleton can identify and inspect the recorded vocal and, when provided, its matching reference; distinguish measured facts from tentative cues; make a small and reversible set of device changes aligned with the user's stated goal; and report what changed and what still needs listening. On an explicit Auto Shift request, it can use a user-confirmed target scale or a conservative Chromatic setting when no scale is known and Live exposes that option. V1 does not automatically match the recorded melody note by note to the reference.

## Existing capabilities and constraints

- `analyze_song` can decode source audio and report source-file features, including level range, near-full-scale sample share, 5–10 kHz sibilance candidates, low-frequency burst candidates, and coarse spectral balance.
- Those vocal cues are screening measurements. They are not diagnoses of clipping, sibilance, plosives, pitch accuracy, or perceived clarity.
- The repository has reference-audio analysis for general audio features and section-level matching. It does not extract vocal pitch contours or compare sung notes. Source-file analysis can read audio clip files when Live exposes their paths; rendered track analysis is pre-FX.
- Source-file analysis is pre-warp, pre-gain, and pre-device. `analyze_rendered_track` renders arranged audio pre-FX, so it does not measure the track's device-chain output.
- AIbleton can inspect, insert, and set parameters on built-in Live devices. Device parameter names and ranges should be read from Live rather than assumed.
- Live 12.1 introduced Auto Shift, which can correct a monophonic vocal toward a configured scale. A specific key/scale requires user confirmation. If the user explicitly requests Auto Shift without naming a key, AIbleton may use Live's Chromatic option for gentle nearest-semitone correction after inspecting the device's available parameters. It must not infer the correct scale from the reference vocal.
- Live 12.3 Suite introduced built-in Stem Separation. The user can separate the original song into a vocal stem in Live; AIbleton V1 consumes the resulting audio clip/file when available but does not trigger or manage the separation operation. Users may also provide an already-isolated reference vocal, so Live 12.3 Suite is not a requirement for every reference-comparison workflow.
- Stem separation can leave bleed or artifacts. A separated vocal is a useful reference source, not guaranteed clean ground truth.

## V1 experience

1. The user names their recorded vocal track and, optionally, a matching reference vocal track/file. If the reference is a full song, the user first uses Live Stem Separation to create its vocal stem or supplies an isolated vocal. AIbleton resolves the tracks and checks that they are audio tracks with readable source audio.
2. AIbleton reads both tracks' clips, device chains, and relevant device parameters. For a reference comparison, it checks that the selected clips represent corresponding passages; if the pairing is unclear, it asks the user to identify the matching section. It reports available audio measurements and screening cues without treating them as pitch or performance diagnoses.
3. AIbleton supports side-by-side audition and reports only broad measurable differences exposed by current analysis. V1 does not report which sung notes are sharp or flat, or claim that the two performances are aligned note by note.
4. AIbleton maps the user's stated goal to a conservative processing proposal. For clarity/forwardness, it may use EQ Eight and Compressor. If the user explicitly requests Auto Shift and supplies a root and scale, AIbleton may configure those values. If the user requests Auto Shift without a known scale, it may configure a gentle Chromatic correction when Live exposes that option, clearly explaining that this centers notes to semitones rather than following the reference melody. Gate, saturation, reverb, and pitch correction are not inserted by default.
5. AIbleton applies only changes that directly serve the user's request, using built-in devices and values/ranges discovered from Live. Existing devices should be adjusted before adding duplicates when a suitable device is already present.
6. AIbleton reports which devices and parameters changed, what evidence informed the choices, what remains uncertain, and asks the user to audition the result against the reference. The user can request another adjustment in ordinary language.

## Behavior boundaries

- Do not invent specific frequency problems, pitch-stability results, or perceptual diagnoses from broad-band measurements.
- Do not treat a vocal stem as artifact-free, or compare unrelated passages as if they were the same phrase. Ask the user to clarify the matching section when clip timing or identity is ambiguous.
- Do not claim the post-processing sound was analyzed or verified in V1. The user audition is the quality feedback loop.
- Do not add Auto Shift unless pitch correction is explicitly requested. Use a specific root and scale only when confirmed by the user; otherwise, use Chromatic only if it is present in Live's parameter metadata and the request permits general intonation correction. Preserve an existing specific scale unless the user asks to change it. Do not infer the target scale from the reference vocal.
- When using Chromatic, disclose that it does not identify wrong melody notes or match the original vocal. If Live does not expose a usable Chromatic option, ask for the target root and scale before changing the device.
- Do not claim note-level pitch or timing differences, automatic phrase alignment, or reference-melody correction in V1.
- Do not invoke Live Stem Separation automatically. The user must create the stem in Live or supply an isolated reference file.
- Do not add a fixed chain to every vocal. Device selection and settings depend on the user's requested outcome and the observed signal.
- Preserve existing processing where possible. Make a focused, undoable change; do not delete or replace existing devices as a routine optimization step.
- If the target is ambiguous, not an audio track, has no readable source audio, or has an unsupported configuration, explain the limit and ask for the missing information or offer a safe next step.

## Processing and feedback model

The initial workflow is human-in-the-loop:

```text
Resolve recorded vocal and optional reference → Confirm matching passage → Compare available cues and audition A/B → Propose/apply focused edits → User auditions → Refine on request
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

- AIbleton-triggered stem separation, external source-separation services, denoising, de-reverberation, de-plosive repair, declipping, or voice-enhancement services. The user may use Live's built-in Stem Separation before asking AIbleton to compare vocals.
- Uploading vocal audio to an external processing service.
- Automatic pitch/key detection for vocal tuning, note-by-note pitch comparison, automatic phrase alignment, and correction that follows the reference melody. Explicitly requested Auto Shift with a confirmed scale or a disclosed Chromatic fallback is included.
- Guaranteed de-essing or exact sibilance-frequency localization.
- Automatic loudness normalization or mastering.
- Background processing that changes a track without a user request.

## Acceptance criteria

1. Given a named recorded vocal track with readable clips, the workflow inspects the track and device chain before proposing edits. If a reference is supplied, it also inspects the reference track/file and confirms or asks about the matching passage.
2. A Live-created vocal stem or separately supplied isolated vocal can be used as the reference when its source audio is readable. If the user has not isolated vocals from a full mix, AIbleton explains that a vocal stem or isolated file is needed for this workflow.
3. The workflow reports only measurements exposed by current analysis and describes heuristic cues as candidates, not confirmed defects. It makes no note-level pitch or timing claims.
4. A clarity/forwardness request does not automatically add pitch correction, denoising, reverb, or a fixed multi-device chain. An explicit Auto Shift request with confirmed root and scale may use that scale; without one, it may use a gentle Chromatic setting only when Live exposes the option, and must explain its limited effect.
5. Device parameters are resolved from Live's current parameter metadata; unknown devices or parameters do not produce guessed values.
6. Changes are scoped to the requested recorded vocal track and can be undone through Live's normal undo behavior.
7. The completion message identifies edits made, states what comparison evidence was used, and asks the user to audition; it does not claim post-FX verification.
8. Ambiguous targets or passage pairing, MIDI tracks, unavailable audio sources, and unsupported device operations result in a clear explanation without unrelated Set changes.

## Decisions for this review

- V1 is a guided vocal-improvement workflow with optional isolated-reference comparison and user audition as the feedback loop.
- Live's Stem Separation is a user-operated way to prepare a reference vocal, not an AIbleton V1 operation. Auto Shift is available only on explicit request, with either a user-confirmed scale or a disclosed Chromatic fallback supported by Live.
- Note-level pitch analysis and correction toward the reference melody are deferred.
- Processing-after-effect measurement is a feasibility probe and a possible later phase, not a V1 promise.
- External AI audio repair and automatic reference-melody tuning are explicitly deferred.

## Self-review

- **Coverage:** Goal, user, success, existing capabilities, optional reference flow, boundaries, failure cases, feasibility probe, exclusions, and acceptance criteria are specified.
- **Consistency:** Reference comparison uses available source-file analysis and user audition; it makes no note-level or post-FX verification claims. Auto Shift is opt-in, and Chromatic correction does not pretend to infer the reference song's key. Reference preparation through Stem Separation is user-operated.
- **Scope:** V1 adds optional comparison against a readable isolated vocal and scale-based correction through native Live devices. Automated note-level comparison, alignment, and reference-melody correction remain out of scope.
- **Ambiguity:** The user must identify a matching reference passage when clip identity/timing is unclear. A specific target scale needs user confirmation; otherwise, a requested Chromatic correction is labeled as general intonation centering. Exact processing heuristics remain constrained by live parameter metadata and user audition.
- **Evidence:** Existing repository behavior was checked in `AIbleton/src/dsp.ts`, `AIbleton/src/audiofiles.ts`, `AIbleton/src/music/reference/analyze.ts`, `AIbleton/src/tools/definitions.ts`, and `AIbleton/src/tools/dispatcher.ts`. Live's Stem Separation, Auto Shift, and Convert Melody behavior are grounded in the Live 12 manual and release notes.
