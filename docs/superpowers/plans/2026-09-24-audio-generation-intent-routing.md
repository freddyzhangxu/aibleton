# Paid Audio Generation Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route MIDI-suitable music requests to MIDI by default and prevent generic creation verbs or audio-asset requests from triggering paid AI audio generation without consent.

**Architecture:** This is a prompt-policy change in the existing system prompt. It classifies by requested deliverable, routes audio-asset requests through the existing local sample search first, and leaves `generate_audio` and its runtime cost confirmation unchanged.

**Tech Stack:** TypeScript; `AIbleton/src/prompts.ts` system-prompt template.

**Spec:** `docs/superpowers/specs/2026-09-24-audio-generation-intent-routing-design.md`

## Global Constraints

- Generic action verbs—生成、创建、制作, and make/create/produce/generate—do not authorize paid audio generation.
- Musical patterns and parts such as drum patterns, melodies, basslines, and chords default to MIDI clips using Live instruments or drum kits.
- Audio assets such as samples, audio loops, stems, vocals, ambience, and sound effects first use `search_samples` to find local material. A request for an audio asset alone does not authorize paid AI generation.
- Call `generate_audio` only when the current request explicitly asks for AI-generated audio, or after local search returns no suitable material and the user agrees to generation.
- Keep the existing runtime confirmation for each paid generation call. An explicit generation request expresses intent; the runtime confirmation remains the final spending gate, except where the product already has an explicit pre-authorized refinement flow.
- If the requested result cannot reasonably be represented as MIDI and no suitable local asset is available, ask whether the user wants AI-generated audio.

## Project Constraints

- Preserve all existing user changes in `AIbleton/src/prompts.ts`; edit only the audio-generation guidance required by the spec.
- Do not add or run automated tests unless the user asks for testing or verification.

## Review Focus

- “Generate a melody” and “生成一段旋律” must remain MIDI requests even though they use “generate/生成.”
- “Make a beat” and “制作一段鼓点” must use the existing MIDI and Live drum-kit workflow.
- “I need an audio loop” or “生成一个音频 loop/sample” must search local samples; the wording does not specify AI generation.
- “用 AI 生成一个音频 loop” specifies AI generation and still uses the runtime confirmation.
- If local search finds no suitable sample, the assistant must ask before paid generation.
- “Use AI to generate an audio loop” may call `generate_audio` only through the existing runtime confirmation; enabled pre-authorized refinement continues to use its existing budget.

---

### Task 1: Clarify generation routing in the system prompt

**Files:**
- Modify: `AIbleton/src/prompts.ts` — the `AI audio generation` section around the existing priority rule.
- Test: None. This task changes prompt policy only; no automated tests will be added or run under the current instruction.

**Interfaces:**
- Consumes: Existing `search_samples`, MIDI-writing, `generate_audio`, and runtime confirmation workflows.
- Produces: A direct model instruction that selects MIDI, local samples, or paid AI audio generation from the requested deliverable and consent.

- [x] **Step 1: Replace the ambiguous generation trigger**

Edit only the policy guidance in the `AI audio generation` section. State that verbs alone never signal paid generation, distinguish an audio-asset request from a request to use AI, and make MIDI the default for MIDI-suitable patterns. Use wording equivalent to:

```text
- Choose the route from the requested deliverable, not from a generic action verb. Words like generate/create/make/produce or 生成/创建/制作 do NOT by themselves mean AI audio generation. Explicit AI-generation intent means the user specifies the method (e.g. “用 AI 生成音频”). “生成一个音频 loop/sample” names an asset but does not specify AI generation. Drum patterns, melodies, basslines and chords default to MIDI clips with Live instruments or drum kits. For audio-asset requests without explicit AI-generation intent, search local samples first. If no suitable asset is found, ask whether to use AI. Call generate_audio only for explicit AI-generation intent or after local search and the user's agreement.
```

- [x] **Step 2: Keep cost-confirmation wording accurate**

Replace the unconditional sentence “Every generate_audio call is confirmed by the user before it runs” with wording that matches the runtime: ordinary paid generations require confirmation, while the existing enabled auto-refinement flow uses its pre-authorized refinement budget. Do not change runtime behavior.

- [x] **Step 3: Review the focused diff against the routing examples**

Inspect the `AI audio generation` section and the final source diff. Confirm that each case in `Review Focus` has an unambiguous route, that sample search and the user-consent gate are explicit, and that the unrelated local drum-layout edits in `prompts.ts` remain intact. The user explicitly requested that all remaining visible changes be committed, so include the existing drum edits and this plan file in that commit. Keep the design spec under the repository's intentionally ignored `docs/superpowers/specs/` path ignored.

**Completion evidence:** The prompt states each routing rule plainly, the paid-generation condition requires explicit intent or affirmative consent after an unsuccessful search, and the existing confirmation mechanism is described accurately. No test run is claimed.
