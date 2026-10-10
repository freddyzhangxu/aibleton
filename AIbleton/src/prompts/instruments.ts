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

function sourceOptions(role: string): string {
  const options = new Set<string>();
  for (const recipe of Object.values(SOUND_RECIPES).filter((candidate) => candidate.role === role)) {
    if (recipe.source === "sample") options.add("sample");
    else if (recipe.source === "synth") options.add(`synth ${recipe.instrument ?? recipe.fallbackInstrument}`);
    else {
      options.add("sample");
      options.add(`synth ${recipe.fallbackInstrument}`);
    }
  }
  return [...options].join(", ");
}

export function instrumentPromptFor(userText: string, intentText: string, simpleEdit?: "tempo" | "mixer"): string {
  if (simpleEdit) return "";
  if (!isInstrumentIntent(intentText)) return "";
  const selectedRoles = selectedInstrumentRoles(intentText);
  const selectedDefaults = Object.entries(DEFAULT_INSTRUMENT_BY_ROLE)
    .filter(([role]) => !selectedRoles || selectedRoles.some((selected) => selected.toLowerCase() === role))
    .map(([role, device]) => `${role}: ${device}`)
    .join(", ");
  const defaultInstruction = selectedRoles
    ? selectedDefaults ? `When a profile leaves the selected role unresolved, use its stable default: ${selectedDefaults}.` : ""
    : `For generic instrument insertion without source-selection intent, use the genre-aware source guidance first; when none resolves, use these role defaults: ${selectedDefaults}; bass: ${DEFAULT_INSTRUMENT_BY_ROLE.bass} (recipe fallback only).`;
  const availableSources = ["Bass", "Guitar", "Piano", "Keys", "Lead", "Pad", "Pluck"]
    .filter((role) => !selectedRoles || selectedRoles.includes(role as GenrePartRole))
    .map((role) => `${role}: ${sourceOptions(role.toLowerCase())}`)
    .join("; ");
  return [
    "\n\nInstrument selection rule: preserve existing instruments and never replace them implicitly.",
    "For every new sound-source request, create a dedicated MIDI track, name it for the role or explicitly requested source, then apply the source recipe to that new track.",
    "If the request names an existing track without explicitly asking to replace or change its sound source, leave it intact and create a new track for comparison. Only target a pre-existing track when the user explicitly asks to replace or change its sound source.",
    "An explicitly named instrument or source type takes precedence over profile guidance. Prefer the genre/subgenre in the current request, then inspect the current Set context; use artist memory only as a source preference when both leave the choice open. Do not infer the current song's genre from artist memory.",
    `For a complete arrangement, use musical judgment to choose complementary roles. Profiles may guide only whether a role uses a sample or a named built-in synth, never how to design that source's timbre. Available sources by role: ${availableSources}.`,
    "Use the generic source_bass_sample/source_bass_synth-style recipe IDs that match the role and source type. When a profile or user names a built-in synth, pass that exact device in instrument_name. Use apply_sound_recipe only to establish the selected source or load a selected sample. Do not apply recipe envelope, filter, oscillator, or other timbre settings; leave sound design to musical judgment and any specific user request.",
    genreInstrumentProfilePrompt(userText, selectedRoles),
    genreDrumProfilePrompt(intentText),
    "For sample playback, use the appropriate one-shot or loop mode; loop-based Pad samples require Simpler Classic plus Loop On. Search local samples and explain a synth fallback when no suitable local sample is available.",
    `Preserve effects and all other Set content on existing tracks. ${defaultInstruction} Ask when the musical role or requested source is unclear before inserting an instrument. Never pass device_name "random".`,
  ].filter(Boolean).join(" ");
}
