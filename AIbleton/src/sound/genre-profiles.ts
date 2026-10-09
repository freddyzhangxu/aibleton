import { SOUND_RECIPES, type SoundRecipeId } from "./recipes.js";

export type GenrePartRole = "Bass" | "Guitar" | "Piano" | "Keys" | "Lead" | "Melody" | "Pad" | "Pluck";

export type GenreInstrumentChoice = {
  instrument: string;
  recipe?: SoundRecipeId;
  sourcePreference?: "sample" | "synth";
  when?: string;
  capabilityNote?: string;
};

export type GenrePartProfile = {
  role: GenrePartRole;
  choices: readonly GenreInstrumentChoice[];
};

export type GenreSubgenreProfile = {
  label: string;
  aliases: readonly string[];
  overrides: readonly GenrePartProfile[];
};

export type GenreProfile = {
  label: string;
  aliases: readonly string[];
  coreParts: readonly GenrePartProfile[];
  optionalParts: readonly GenrePartProfile[];
  subgenres: readonly GenreSubgenreProfile[];
};

/** Profiles reference only recipes that apply_sound_recipe already supports. */
export const GENRE_INSTRUMENT_PROFILES = {
  rock: {
    label: "Rock",
    aliases: ["rock", "rock music"],
    coreParts: [
      { role: "Bass", choices: [{ instrument: "electric bass", recipe: "rock_bass" }] },
      { role: "Guitar", choices: [{ instrument: "guitar", recipe: "pluck_guitar", capabilityNote: "general guitar sample; not guaranteed to be a genre-specific electric-guitar tone" }] },
    ],
    optionalParts: [
      { role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] },
    ],
    subgenres: [],
  },
  jazz: {
    label: "Jazz",
    aliases: ["jazz", "straight-ahead jazz", "straight ahead jazz"],
    coreParts: [
      { role: "Bass", choices: [{ instrument: "upright bass", recipe: "jazz_bass" }] },
      { role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] },
    ],
    optionalParts: [
      { role: "Guitar", choices: [{ instrument: "guitar", recipe: "pluck_guitar", capabilityNote: "general guitar sample; not guaranteed to be a genre-specific guitar tone" }] },
      { role: "Pluck", choices: [{ instrument: "warm synth pluck", recipe: "pluck_warm" }] },
    ],
    subgenres: [
      {
        label: "Jazz Fusion",
        aliases: ["jazz fusion", "fusion"],
        overrides: [
          { role: "Bass", choices: [{ instrument: "electric bass", recipe: "jazz_fusion_bass" }] },
          { role: "Keys", choices: [{ instrument: "FM keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation, not a Rhodes preset" }] },
        ],
      },
      {
        label: "Bossa Nova",
        aliases: ["bossa nova", "bossa", "bossanova"],
        overrides: [{ role: "Bass", choices: [{ instrument: "upright bass", recipe: "bossa_bass" }] }],
      },
    ],
  },
  funk: {
    label: "Funk",
    aliases: ["funk", "funk music"],
    coreParts: [
      { role: "Bass", choices: [{ instrument: "fingerstyle electric bass", recipe: "funk_bass" }] },
    ],
    optionalParts: [
      { role: "Guitar", choices: [{ instrument: "guitar", recipe: "pluck_guitar", capabilityNote: "general guitar sample; not guaranteed to be a genre-specific electric-guitar tone" }] },
      { role: "Keys", choices: [{ instrument: "FM keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation, not a Clavinet preset" }] },
      { role: "Lead", choices: [{ instrument: "analog synth lead", recipe: "lead_analog" }] },
      { role: "Melody", choices: [{ instrument: "analog synth lead", recipe: "lead_analog" }] },
    ],
    subgenres: [
      {
        label: "Funk Slap",
        aliases: ["slap funk", "funk slap", "slap bass funk"],
        overrides: [{ role: "Bass", choices: [{ instrument: "slap electric bass", recipe: "funk_slap_bass" }] }],
      },
      {
        label: "Funk Pick",
        aliases: ["picked funk", "funk pick", "pick bass funk"],
        overrides: [{ role: "Bass", choices: [{ instrument: "picked electric bass", recipe: "funk_pick_bass" }] }],
      },
      {
        label: "Disco Funk",
        aliases: ["disco funk", "funk disco"],
        overrides: [{ role: "Lead", choices: [{ instrument: "analog synth lead", recipe: "lead_analog" }] }],
      },
    ],
  },
} as const satisfies Readonly<Record<string, GenreProfile>>;

function sourceLabel(recipeId: SoundRecipeId): string {
  const recipe = SOUND_RECIPES[recipeId];
  return recipe.source === "sample" ? "sample" : recipe.source === "synth" ? `synth ${recipe.instrument}` : "contextual source";
}

function formatChoice(choice: GenreInstrumentChoice): string {
  const condition = choice.when ? ` when ${choice.when}` : "";
  const capability = choice.capabilityNote ? `; ${choice.capabilityNote}` : "";
  if (!choice.recipe) return `${choice.instrument}${condition}${capability}`;

  const recipe = SOUND_RECIPES[choice.recipe];
  const sourcePreference = choice.sourcePreference ? `; prefer ${choice.sourcePreference}` : "";
  return `${choice.instrument}${condition} (${choice.recipe}, ${sourceLabel(choice.recipe)}; fallback ${recipe.fallbackInstrument}${sourcePreference}${capability})`;
}

function formatPart(part: GenrePartProfile): string {
  return `${part.role} → ${part.choices.map(formatChoice).join(" or ")}`;
}

function formatSubgenre(subgenre: GenreSubgenreProfile): string {
  const overrides = subgenre.overrides.map(formatPart).join("; ");
  return `${subgenre.label} aliases: ${subgenre.aliases.join(", ")}. ${subgenre.label} overrides: ${overrides}`;
}

function formatProfile(profile: GenreProfile): string {
  const core = profile.coreParts.map(formatPart).join("; ") || "none declared";
  const optional = profile.optionalParts.map(formatPart).join("; ") || "none declared";
  const subgenres = profile.subgenres.map(formatSubgenre).join(". ");
  return `${profile.label} aliases: ${profile.aliases.join(", ")}. Core parts: ${core}. Optional parts: ${optional}.${subgenres ? ` ${subgenres}.` : ""}`;
}

/** Build the prompt section from the same recipe catalog used by apply_sound_recipe. */
export function genreInstrumentProfilePrompt(): string {
  const profiles = Object.values(GENRE_INSTRUMENT_PROFILES).map(formatProfile);
  return [
    `Genre-to-instrument profiles for new parts only: ${profiles.join(" ")}`,
    "An explicit subgenre overrides the parent genre for listed roles; inherit the parent profile for roles it does not change.",
    "If no listed subgenre matches, retain the parent genre profile and do not guess a subgenre override.",
    "For a complete genre-led arrangement, choose a compact, conventional subset of core and optional parts; for a named-part request, apply only that role's mapping. Do not create every listed part automatically.",
    "For the remaining role and genre pairs, continue using an existing role-specific timbre match; if none applies, use the role default when defined.",
    "Leave unsupported role and genre combinations unresolved and ask one concise question.",
    "When a listed sample is unavailable, use its declared synth fallback and explain the approximation.",
    "Do not invent a recipe or imply an unsupported genre-specific sound.",
  ].join(" ");
}
