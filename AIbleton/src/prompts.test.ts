import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT, systemPromptFor } from "./prompts.js";
import { instrumentPromptFor } from "./prompts/instruments.js";
import { DEFAULT_INSTRUMENT_BY_ROLE } from "./tools/instruments.js";

test("keeps track indices internal and presents user-facing tracks one-based", () => {
  assert.match(SYSTEM_PROMPT, /0-based INTERNAL tool coordinates/);
  assert.match(SYSTEM_PROMPT, /“first track” maps to track_index 0/);
  assert.match(SYSTEM_PROMPT, /one-based ordinal and current name/);
  assert.match(SYSTEM_PROMPT, /“Track 1 \(Drums\)”, translated into the turn's reply language/);
  assert.match(SYSTEM_PROMPT, /Never expose a bare raw track index/);
  assert.doesNotMatch(SYSTEM_PROMPT, /[\u3400-\u9fff]/u);
});

test("injects one explicit reply language for the turn", () => {
  const prompt = systemPromptFor("es");
  assert.match(prompt, /Reply language for this turn: Spanish \(es\)/);
  assert.match(prompt, /Use Spanish for all user-facing prose/);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});

test("uses producer BPM memory only when the creation genre is unspecified", () => {
  assert.match(SYSTEM_PROMPT, /explicitly names a numeric BPM\/tempo[\s\S]*?use it as the target; it overrides all other tempo guidance/);
  assert.match(SYSTEM_PROMPT, /resolve the genre\/subgenre from the current request or the matched skill/);
  assert.match(SYSTEM_PROMPT, /choose a BPM for that music type/);
  assert.match(SYSTEM_PROMPT, /prefer tempo guidance in the matched skill/i);
  assert.match(SYSTEM_PROMPT, /use a conventional tempo for the requested genre/);
  assert.match(SYSTEM_PROMPT, /Only when neither the current request nor the matched skill establishes a music type, use the BPM range in artist memory/);
  assert.match(SYSTEM_PROMPT, /choose its midpoint/);
  assert.match(SYSTEM_PROMPT, /If artist memory has no BPM, preserve the Live Set's current tempo/);
  assert.match(SYSTEM_PROMPT, /Do not infer the current music type from artist-memory genres/);
});

test("makes named device replacement a verified sample-swap workflow", () => {
  assert.match(SYSTEM_PROMPT, /replace or swap a NAMED device\/instrument/);
  assert.match(SYSTEM_PROMPT, /do NOT call set_goal or set_plan/);
  assert.match(SYSTEM_PROMPT, /load_sample loads into an existing Simpler or inserts one itself/);
  assert.match(SYSTEM_PROMPT, /delete ONLY the named source device/);
  assert.match(SYSTEM_PROMPT, /get_simpler_sample to verify every target/);
});

test("uses delete-first replacement for named built-in device swaps", () => {
  assert.match(SYSTEM_PROMPT, /replace_device/);
  assert.match(SYSTEM_PROMPT, /deletes the named source first/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /allow_delete_first/);
});

test("keeps user bar ranges out of invented goal-section names", () => {
  assert.match(SYSTEM_PROMPT, /A user bar range is edit scope, not automatically a Section name/);
  assert.match(SYSTEM_PROMPT, /Never invent, merge, or normalize a Section name yourself/);
});

test("uses executable plans only when every step is known or references an earlier result", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /set_plan is declaration-only by default/);
  assert.match(prompt, /For a fully specified multi-step task, you MUST set execute: true/);
  assert.match(prompt, /execute: true/);
  assert.match(prompt, /\$ref/);
  assert.match(prompt, /earlier successful step result/);
  assert.match(prompt, /create_midi_track returns the new track name as "created"/);
  assert.match(prompt, /Do not call a successfully executed step again/);
  assert.match(prompt, /a read whose result determines a later argument must happen before the plan/i);
  assert.match(prompt, /including creative passes without set_goal/);
});

test("auto-creates a MIDI track when MIDI writing targets an Audio Track", () => {
  assert.match(SYSTEM_PROMPT, /automatically creates an empty MIDI Track and writes the MIDI there/);
  assert.match(SYSTEM_PROMPT, /created_position_relative_to_source/);
  assert.match(SYSTEM_PROMPT, /Do not retry the same write after an auto-created result/);
});

test("selects a stable instrument by musical role when none is named", () => {
  const prompt = instrumentPromptFor("Create a new sound", "Create a new sound");
  assert.match(prompt, /Never pass device_name "random"/);
  for (const [role, device] of Object.entries(DEFAULT_INSTRUMENT_BY_ROLE)) {
    assert.match(prompt, new RegExp(`${role}: ${device}`));
  }
  assert.match(prompt, /For generic instrument insertion without source-selection intent, use the genre-aware source guidance first/);
  assert.match(prompt, /ask when the musical role or requested source is unclear/i);
});

test("uses genre guidance only for source selection and leaves timbre design open", () => {
  const prompt = instrumentPromptFor("Create a melodic techno bassline", "Create a melodic techno bassline");
  assert.match(prompt, /prefer the genre\/subgenre in the current request, then inspect the current Set context[\s\S]*use artist memory only as a source preference/i);
  assert.match(prompt, /profiles may guide only whether a role uses a sample or a named built-in synth, never how to design that source's timbre/i);
  assert.match(prompt, /Use apply_sound_recipe only to establish the selected source or load a selected sample/);
  assert.match(prompt, /Do not apply recipe envelope, filter, oscillator, or other timbre settings/);
  assert.doesNotMatch(prompt, /Lead → clean rounded synth lead|Ambient → airy|House\/Techno with no timbre detail, use aggressive/);
  assert.match(prompt, /An explicitly named instrument or source type takes precedence/);
  assert.match(prompt, /preserve existing instruments and never replace them implicitly/);
});

test("puts new source designs on dedicated MIDI tracks unless replacement is explicit", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /For every new sound-source request, create a dedicated MIDI track, name it for the role or explicitly requested source, then apply the source recipe to that new track/);
  assert.match(prompt, /Only target a pre-existing track when the user explicitly asks to replace or change its sound source/);
  assert.match(prompt, /If the request names an existing track without explicitly asking to replace or change its sound source, leave it intact and create a new track for comparison/);
  assert.doesNotMatch(prompt, /Apply recipes to the named or selected MIDI track/);
});

test("maps genre profiles to source types without prescribing timbre recipes", () => {
  const prompt = instrumentPromptFor("Create Rock, Jazz Fusion, and Funk parts", "Create Rock, Jazz Fusion, and Funk parts");
  assert.match(prompt, /Rock aliases:.*Role-to-source mappings: Bass → sample; Guitar → sample[^;]*; Piano → sample/);
  assert.match(prompt, /Jazz aliases:.*Role-to-source mappings: Bass → sample/);
  assert.match(prompt, /Jazz Fusion overrides: Bass → sample/);
  assert.match(prompt, /Funk aliases:.*Role-to-source mappings: Bass → sample.*Keys → synth Operator/);
  assert.match(prompt, /Use profiles as suggestions only for sample versus synth or a named built-in synth source/);
  assert.match(prompt, /For an unlisted role, choose a suitable source using musical judgment/);
  assert.doesNotMatch(prompt, /warm synth pluck|clean electric guitar|analog synth lead|Clavinet-style/);
  assert.doesNotMatch(prompt, /Core parts:|Optional parts:/);
  assert.match(prompt, /When a profile or user names a built-in synth, pass that exact device in instrument_name/);
});

test("does not prescribe Guitar timbre from genre or style labels", () => {
  const prompt = instrumentPromptFor("Create a Rock guitar part", "Create a Rock guitar part");
  assert.match(prompt, /Guitar: sample/);
  assert.doesNotMatch(prompt, /acoustic\/nylon →|muted\/Funk →|overdrive\/distortion →/i);
});

test("keeps Piano and Keys source choices without prescribing their timbre", () => {
  const prompt = instrumentPromptFor("Add piano and keys", "Add piano and keys");
  assert.match(prompt, /Piano: sample/);
  assert.match(prompt, /Keys: (?:sample, )?synth Operator/);
  assert.doesNotMatch(prompt, /Rhodes\/tine\/electric piano →|Clav\/Clavinet →/);
});

test("uses current Set context before artist memory when a sound choice is open", () => {
  const prompt = instrumentPromptFor("Create a bassline", "Create a bassline");
  assert.match(prompt, /prefer the genre\/subgenre in the current request, then inspect the current Set context[\s\S]*use artist memory only as a source preference when both leave the choice open/i);
});

test("lets musical judgment choose a complete arrangement lineup across genres", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /there is no fixed role lineup for any genre/);
  assert.match(prompt, /Profiles do not mandate or exclude roles/);
  assert.match(prompt, /A request for one named part stays scoped to that part/);
  assert.doesNotMatch(prompt, /core\/optional parts/);
  assert.doesNotMatch(prompt, /choose a compact, conventional subset of core and optional parts/);
});
