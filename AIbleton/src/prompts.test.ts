import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT, systemPromptFor } from "./prompts.js";
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
  const prompt = systemPromptFor("en");
  assert.match(prompt, /Never pass device_name "random"/);
  for (const [role, device] of Object.entries(DEFAULT_INSTRUMENT_BY_ROLE)) {
    assert.match(prompt, new RegExp(`${role}: ${device}`));
  }
  assert.match(prompt, /ask the user when the musical role is unclear/i);
});

test("chooses genre-aware timbres for new melodic parts without replacing named or existing sources", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /for any new part, prefer the genre\/subgenre in the current request, then inspect the current Set context[\s\S]*use relevant artist memory only as a preference/i);
  assert.match(prompt, /For genres in the profile catalog, follow its Lead\/Melody mapping/);
  assert.match(prompt, /Pop aliases:.*Lead → clean rounded synth lead \(lead_clean/);
  assert.match(prompt, /Funk aliases:.*Lead → analog synth lead \(lead_analog/);
  assert.match(prompt, /for unprofiled House\/Techno with no timbre detail, use aggressive/);
  assert.match(prompt, /Ambient → airy/);
  assert.match(prompt, /An explicitly named instrument or timbre takes precedence/);
  assert.match(prompt, /never replace an existing instrument implicitly/);
  assert.match(prompt, /For generic instrument insertion without sound-design intent, use the genre-aware rule first; when none resolves, use these role defaults/);
});

test("puts new sound designs on dedicated MIDI tracks unless replacement is explicit", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /For every new sound-design request, create a dedicated MIDI track, name it for the role or timbre, then apply the recipe to that new track/);
  assert.match(prompt, /Only target a pre-existing track when the user explicitly asks to replace or change its sound source/);
  assert.match(prompt, /If the request names an existing track without explicitly asking to replace or change its sound source, leave it intact and create a new track for comparison/);
  assert.doesNotMatch(prompt, /Apply recipes to the named or selected MIDI track/);
});

test("maps Rock, Jazz, and Funk parts to available recipes and handles gaps explicitly", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /Rock aliases:.*Role-to-sound mappings: Bass → electric bass \(rock_bass, sample; fallback Operator\).*Guitar → overdriven electric guitar.*guitar_overdrive.*clean electric guitar.*guitar_clean.*Piano → piano \(keys_piano_sample/);
  assert.match(prompt, /Jazz aliases:.*Role-to-sound mappings: Bass → upright bass \(jazz_bass/);
  assert.match(prompt, /Jazz Fusion overrides: Bass → electric bass \(jazz_fusion_bass/);
  assert.match(prompt, /Jazz aliases:.*Guitar → clean electric\/hollowbody guitar \(guitar_clean.*Pluck → warm synth pluck \(pluck_warm/);
  assert.match(prompt, /Funk aliases:.*Role-to-sound mappings: Bass → fingerstyle electric bass \(funk_bass/);
  assert.match(prompt, /Funk aliases:.*Guitar → muted funk guitar \(guitar_muted.*Keys → Clavinet-style percussive keyboard \(keys_clav_synth.*Operator approximation.*Lead → analog synth lead \(lead_analog.*Melody → analog synth lead \(lead_analog/);
  assert.match(prompt, /Funk Pick aliases: picked funk, funk pick, pick bass funk\. Funk Pick overrides: Bass → picked electric bass \(funk_pick_bass/);
  assert.match(prompt, /Operator approximation, not a Clavinet preset/);
  assert.match(prompt, /Use profiles as suggestions for instrument and timbre choices while exercising musical judgment about which roles a complete arrangement needs/);
  assert.match(prompt, /For an unlisted role, choose a suitable sound using musical judgment/);
  assert.doesNotMatch(prompt, /Core parts:|Optional parts:/);
  assert.match(prompt, /Use the profile catalog as the single source of genre-to-recipe mappings/i);
  assert.match(prompt, /When a profile specifies source_preference, pass that value to apply_sound_recipe/);
  assert.doesNotMatch(prompt, /For pop, an explicit pop-rock request uses rock_bass/);
  assert.doesNotMatch(prompt, /For jazz, use jazz_bass by default/);
  assert.doesNotMatch(prompt, /If genre only, House\/Techno → bright, Jazz\/Bossa → warm, Pop\/Cinematic → bell/);
  assert.doesNotMatch(prompt, /With genre only, Pop → clean, Funk\/Disco → analog, House\/Techno → aggressive/);
});

test("selects Guitar recipes by acoustic, clean, muted, or overdriven character", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /acoustic\/nylon.*guitar_acoustic.*clean.*guitar_clean.*muted\/funk.*guitar_muted.*overdrive\/distortion.*guitar_overdrive/i);
  assert.match(prompt, /generic Guitar with no matching profile may use the broad pluck_guitar sample/);
  assert.match(prompt, /broad pluck_guitar sample and state that it is not genre-specific/);
});

test("separates Piano samples from the broader Keys family", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /Piano is a specific instrument within the Keys family/);
  assert.match(prompt, /Only an explicit Piano request or a genre profile that names Piano selects Piano samples/);
  assert.match(prompt, /Generic Keys never defaults to Piano samples/);
  assert.match(prompt, /Rhodes\/tine\/electric piano → keys_rhodes_synth; Clav\/Clavinet → keys_clav_synth; DX7\/FM → keys_dx7_synth/);
  assert.doesNotMatch(prompt, /Generic Keys or Pop Keys defaults to keys_piano_sample/);
});

test("uses current Set context before artist memory when a sound choice is open", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /prefer the genre\/subgenre in the current request, then inspect the current Set context[\s\S]*use relevant artist memory only as a preference when both leave the choice open/);
});

test("lets musical judgment choose a complete arrangement lineup across genres", () => {
  const prompt = systemPromptFor("en");
  assert.match(prompt, /there is no fixed role lineup for any genre/);
  assert.match(prompt, /Profiles do not mandate or exclude roles/);
  assert.match(prompt, /A request for one named part stays scoped to that part/);
  assert.doesNotMatch(prompt, /core\/optional parts/);
  assert.doesNotMatch(prompt, /choose a compact, conventional subset of core and optional parts/);
});
