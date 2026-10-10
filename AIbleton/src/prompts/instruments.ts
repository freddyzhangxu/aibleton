import { DEFAULT_INSTRUMENT_BY_ROLE } from "../tools/instruments.js";
import { genreDrumProfilePrompt, genreInstrumentProfilePrompt, type GenrePartRole } from "../sound/genre-profiles.js";
import { SOUND_RECIPES } from "../sound/recipes.js";

function isInstrumentIntent(userText: string): boolean {
  return !userText.trim() || /\b(?:bass(?:line)?|kick|drum|lead|melody|pad|pluck|keys?|piano|guitar|instrument|synth|sound|timbre|patch|wavetable|operator|add|create|write|make|build|program|produce|compose|insert|load|replace|swap|bajo|basse|basslinie|basso|guitare|guitarra|chitarra|teclado|tastiera|clavier|mélodie|melodía|melodia|schlagzeug|batterie|batería|instrumento|strumento|instrument|crée|fais|écris|compose|ajoute|crea|haz|escribe|añade|agrega|scrivi|componi|aggiungi|mach|schreib|erstelle)\b|音色|音源|贝斯|鼓|旋律|吉他|钢琴|键盘|合成器|乐器|ベース|ドラム|メロディ|ギター|ピアノ|鍵盤|シンセ|新建|添加|创建|编写|制作|编程|替换|更换|加载/i.test(userText);
}

function selectedInstrumentRoles(userText: string): GenrePartRole[] | undefined {
  const roles: Array<{ role: GenrePartRole; match: RegExp }> = [
    { role: "Bass", match: /\bbass(?:line)?\b|\bbajo\b|\bbasse\b|\bbasslinie\b|\bbasso\b|贝斯|低音贝斯|ベース/i },
    { role: "Guitar", match: /\bguitar\b|\bguitare\b|\bguitarra\b|\bchitarra\b|吉他|ギター/i },
    { role: "Piano", match: /\bpiano\b|钢琴|ピアノ/i },
    { role: "Keys", match: /\bkeys?\b|keyboard|rhodes|clav(?:inet)?|dx7|\bclavier\b|\bteclado\b|\btastiera\b|键盘|鍵盤/i },
    { role: "Lead", match: /\blead\b|主音|领奏/i },
    { role: "Melody", match: /\bmelody\b|\bmelodie\b|\bmelodía\b|旋律|メロディ/i },
    { role: "Lead", match: /\bmelody\b|\bmelodie\b|\bmelodía\b|旋律|メロディ/i },
    { role: "Pad", match: /\bpad\b|铺底|铺垫/i },
    { role: "Pluck", match: /\bpluck\b|拨弦/i },
  ];
  const selected = roles.filter(({ match }) => match.test(userText)).map(({ role }) => role);
  return selected.length ? [...new Set(selected)] : undefined;
}

function recipeNames(role: string, source?: string): string {
  return Object.values(SOUND_RECIPES)
    .filter((recipe) => recipe.role === role && (!source || recipe.source === source))
    .map((recipe) => `${recipe.id} (${recipe.label})`)
    .join(", ");
}

export function instrumentPromptFor(userText: string, intentText: string, simpleEdit?: "tempo" | "mixer"): string {
  if (simpleEdit) return "";
  if (!isInstrumentIntent(intentText)) return "";
  const selectedRoles = selectedInstrumentRoles(intentText);
  const hasRole = (role: GenrePartRole) => !selectedRoles || selectedRoles.includes(role);
  const bassRecipes = hasRole("Bass") ? recipeNames("bass") : "";
  const pluckRecipes = hasRole("Pluck") ? recipeNames("pluck", "synth") : "";
  const pluckSampleRecipes = hasRole("Pluck") ? recipeNames("pluck", "sample") : "";
  const guitarRecipes = hasRole("Guitar") ? recipeNames("guitar", "sample") : "";
  const padRecipes = hasRole("Pad") ? recipeNames("pad", "synth") : "";
  const padSampleRecipes = hasRole("Pad") ? recipeNames("pad", "sample") : "";
  const leadRecipes = hasRole("Lead") ? recipeNames("lead", "synth") : "";
  const leadSampleRecipes = hasRole("Lead") ? recipeNames("lead", "sample") : "";
  const keysSynthRecipes = hasRole("Keys") ? recipeNames("keys", "synth") : "";
  const pianoSampleRecipes = hasRole("Piano") || hasRole("Keys") ? recipeNames("piano", "sample") : "";
  const selectedDefaults = Object.entries(DEFAULT_INSTRUMENT_BY_ROLE)
    .filter(([role]) => !selectedRoles || selectedRoles.some((selected) => selected.toLowerCase() === role))
    .map(([role, device]) => `${role}: ${device}`)
    .join(", ");
  const defaultInstruction = selectedRoles
    ? selectedDefaults ? `When a profile leaves the selected role unresolved, use its stable default: ${selectedDefaults}.` : ""
    : `For generic instrument insertion without sound-design intent, use the genre-aware rule first; when none resolves, use these role defaults: ${selectedDefaults}; bass: ${DEFAULT_INSTRUMENT_BY_ROLE.bass} (recipe fallback only).`;
  const instruments = (
    `\n\nInstrument selection rule: preserve existing instruments and never replace them implicitly. For every new sound-design request, create a dedicated MIDI track, name it for the role or timbre, then apply the recipe to that new track. If the request names an existing track without explicitly asking to replace or change its sound source, leave it intact and create a new track for comparison. Only target a pre-existing track when the user explicitly asks to replace or change its sound source. An explicitly named instrument or timbre takes precedence over profile guidance. For any new part, prefer the genre/subgenre in the current request, then inspect the current Set context to complement existing parts and avoid duplication; use relevant artist memory only as a preference when both leave the choice open. Do not infer the current song's genre from artist memory. For complete arrangements, choose roles using musical judgment based on genre, subgenre, mood, and current Set context; profiles are references for sound and recipe choices, not a fixed lineup or whitelist. When a profile specifies source_preference, pass that value to apply_sound_recipe; omit it when the profile does not specify one.` +
    (hasRole("Bass") ? ` For Bass sound design or a new Bass part, choose one recipe from ${bassRecipes} using the matching profile; if no profile resolves, use the stable Bass default. Apply it to the newly created named MIDI track. The recipe uses actual Live parameters and local sample results; report when it falls back to a synth approximation. ` : "") +
    genreInstrumentProfilePrompt(userText, selectedRoles) + " " +
    genreDrumProfilePrompt(intentText) + " " +
    (hasRole("Guitar") ? `When Guitar is the selected instrument (including Guitar explicitly requested for a Pluck/Lead part), choose from ${guitarRecipes}: acoustic/nylon → guitar_acoustic; clean electric/hollowbody → guitar_clean; muted/Funk → guitar_muted; overdrive/distortion/crunch → guitar_overdrive. Follow the genre profile when the guitar tone is unspecified. A generic Guitar with no matching profile may use the broad pluck_guitar sample and state that it is not genre-specific. Search local one-shot samples using the recipe's filename evidence; if none fit, use its declared synth fallback and explain the approximation. ` : "") +
    (hasRole("Pluck") ? `For Pluck sound design, choose a synth recipe from ${pluckRecipes} unless the user explicitly asks for samples. Preserve explicit sampled instruments: kalimba/mbira/thumb piano → pluck_kalimba. For other explicit Pluck sample requests, choose one sample recipe from ${pluckSampleRecipes}: bright/short/punchy → pluck_bright_sample; warm/soft/mellow → pluck_warm_sample; bell/metallic/FM → pluck_bell_sample. Without sample intent, use the synth profiles: bright/short/punchy → pluck_bright; warm/soft/mellow → pluck_warm; bell/metallic/FM → pluck_bell. For genres in the profile catalog, follow its Pluck mapping; for unprofiled House/Techno with no timbre detail, use bright. Search only local samples; if none fit, report the declared synth fallback. ` : "") +
    (hasRole("Piano") || hasRole("Keys") ? `Piano is a specific instrument within the Keys family. For a new Piano part or explicit Piano request, choose from ${pianoSampleRecipes}: explicit grand/concert/acoustic → keys_piano_grand_sample; felt/upright/soft/warm → keys_piano_felt_sample; otherwise use keys_piano_sample. Only an explicit Piano request or a genre profile that names Piano selects Piano samples; Generic Keys never defaults to Piano samples. For new Keys, choose from ${keysSynthRecipes} when genre, arrangement, or explicit timbre supports a synth/electric keyboard: Rhodes/tine/electric piano → keys_rhodes_synth; Clav/Clavinet → keys_clav_synth; DX7/FM → keys_dx7_synth. Rhodes and Clav recipes are distinct Operator-based approximations, not sampled or exact instrument emulations. If Keys is generic and its sound cannot be resolved from the genre or arrangement, ask whether the user wants Piano or a synth/electric-keyboard sound. Search only local Piano one-shots using recipe-specific filename evidence, reject loops/phrases, and explain the Operator fallback when no suitable sample is found; do not call it a real sampled piano or DX7 preset. ` : "") +
    (hasRole("Pad") ? `For Pad sound design or a new Pad part, choose one synth recipe from ${padRecipes}. Select a sample recipe from ${padSampleRecipes} only when the user explicitly asks for a sample/sampled Pad. Explicit timbre wins: warm/soft/mellow → warm; airy/shimmering/bright → airy; dark/cinematic/drone → dark. With genre only, Ambient → airy, Cinematic → dark, House/Techno → warm.` : "") +
    (hasRole("Lead") ? `For Lead sound design or a new Lead part, choose one synth recipe from ${leadRecipes}. Select a sample recipe from ${leadSampleRecipes} only when the user explicitly asks for a sample/sampled Lead. Explicit timbre wins: clean/clear/rounded → clean; analog/warm/vintage → analog; aggressive/bright/punchy → aggressive. For wide/supersaw Lead, use lead_aggressive on Wavetable as the starting patch unless the genre profile or explicit timbre calls for another base; then inspect the actual Wavetable unison controls and set all relevant values together. For mono/legato/glide Lead, keep the timbre-selected base recipe and inspect that device's actual voice/mono/glide controls before changing them. Use only parameter names, ranges, and options returned by get_device_parameters; if the device exposes no relevant control, keep the base recipe and say that control is unavailable. Do not add effects automatically. For genres in the profile catalog, follow its Lead/Melody mapping; for unprofiled House/Techno with no timbre detail, use aggressive. If no profile resolves, use the stable role default or ask one concise question when no default fits. For a matching new sample recipe, first create a dedicated MIDI track, then apply the recipe there; do not load it onto a pre-existing track unless the user explicitly asks to replace its sound source. A requested Pad sample must use Simpler Classic plus Loop On. If an explicitly requested replacement fails after source deletion, state that the old source was deleted and tell the user to use Live Undo; do not claim the original remains or silently fall back. If no suitable sample is found on a new track, use the recipe's declared synth fallback and explain it. ` : "") +
    (hasRole("Lead") || hasRole("Pluck") ? ` Pluck/Lead samples use non-loop playback. ` : "") +
    `All sample and synth recipes use exact Live parameter aliases and report skipped controls; never claim to have heard the result. Preserve effects and all other Set content on existing tracks. ${defaultInstruction} Ask the user when the musical role is unclear before inserting an instrument. Never pass device_name "random".`
  );
  return instruments;
}
