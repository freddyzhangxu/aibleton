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
  parts: readonly GenrePartProfile[];
  subgenres: readonly GenreSubgenreProfile[];
};

/** Profiles reference only recipes that apply_sound_recipe already supports. */
export const GENRE_INSTRUMENT_PROFILES = {
  pop: {
    label: "Pop",
    aliases: ["pop", "popular music"],
    parts: [
      {
        role: "Bass",
        choices: [
          { instrument: "electric bass", recipe: "pop_bass", sourcePreference: "sample", when: "band/acoustic arrangement" },
          { instrument: "synth bass", recipe: "pop_bass", sourcePreference: "synth", when: "synth/dance arrangement" },
        ],
      },
      { role: "Lead", choices: [{ instrument: "clean rounded synth lead", recipe: "lead_clean" }] },
      { role: "Pluck", choices: [{ instrument: "bell-like synth pluck", recipe: "pluck_bell" }] },
      { role: "Guitar", choices: [{ instrument: "clean electric guitar", recipe: "guitar_clean" }] },
      { role: "Piano", choices: [
        { instrument: "piano", recipe: "keys_piano_sample" },
        { instrument: "soft felt/upright piano", recipe: "keys_piano_felt_sample", when: "a soft or intimate arrangement" },
      ] },
      { role: "Keys", choices: [{ instrument: "FM keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation, not a general synth-keyboard preset" }] },
    ],
    subgenres: [
      {
        label: "Pop Rock",
        aliases: ["pop rock", "pop-rock"],
        overrides: [
          { role: "Bass", choices: [{ instrument: "electric bass", recipe: "rock_bass" }] },
          { role: "Guitar", choices: [{ instrument: "overdriven electric guitar", recipe: "guitar_overdrive" }] },
        ],
      },
      {
        label: "Dance Pop",
        aliases: ["dance pop", "dance-pop"],
        overrides: [
          { role: "Bass", choices: [{ instrument: "synth bass", recipe: "electronic_bass" }] },
          { role: "Guitar", choices: [{ instrument: "clean electric guitar", recipe: "guitar_clean" }] },
        ],
      },
      {
        label: "Synth Pop",
        aliases: ["synth pop", "synth-pop"],
        overrides: [
          { role: "Bass", choices: [{ instrument: "synth bass", recipe: "electronic_bass" }] },
          { role: "Keys", choices: [{ instrument: "FM keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation, not a general synth-keyboard preset" }] },
          { role: "Guitar", choices: [{ instrument: "clean electric guitar", recipe: "guitar_clean" }] },
        ],
      },
    ],
  },
  rock: {
    label: "Rock",
    aliases: ["rock", "rock music"],
    parts: [
      { role: "Bass", choices: [{ instrument: "electric bass", recipe: "rock_bass" }] },
      { role: "Guitar", choices: [
        { instrument: "overdriven electric guitar", recipe: "guitar_overdrive", when: "a distorted/heavy guitar part" },
        { instrument: "clean electric guitar", recipe: "guitar_clean", when: "a clean intro, verse, or ballad part" },
      ] },
      { role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] },
    ],
    subgenres: [
      {
        label: "Piano Rock",
        aliases: ["piano rock", "rock ballad"],
        overrides: [{ role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] }],
      },
      {
        label: "Synth Rock",
        aliases: ["synth rock"],
        overrides: [{ role: "Keys", choices: [{ instrument: "FM keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation, not a general synth-keyboard preset" }] }],
      },
    ],
  },
  jazz: {
    label: "Jazz",
    aliases: ["jazz"],
    parts: [
      { role: "Bass", choices: [{ instrument: "upright bass", recipe: "jazz_bass" }] },
      { role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] },
      { role: "Guitar", choices: [{ instrument: "clean electric/hollowbody guitar", recipe: "guitar_clean" }] },
      { role: "Pluck", choices: [{ instrument: "warm synth pluck", recipe: "pluck_warm" }] },
    ],
    subgenres: [
      {
        label: "Straight-ahead Jazz",
        aliases: ["straight-ahead jazz", "straight ahead jazz"],
        overrides: [{ role: "Bass", choices: [{ instrument: "upright bass", recipe: "jazz_bass" }] }],
      },
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
        overrides: [
          { role: "Bass", choices: [{ instrument: "upright bass", recipe: "bossa_bass" }] },
          { role: "Guitar", choices: [{ instrument: "acoustic/nylon guitar", recipe: "guitar_acoustic" }] },
        ],
      },
    ],
  },
  funk: {
    label: "Funk",
    aliases: ["funk", "funk music"],
    parts: [
      { role: "Bass", choices: [{ instrument: "fingerstyle electric bass", recipe: "funk_bass" }] },
      { role: "Guitar", choices: [{ instrument: "muted funk guitar", recipe: "guitar_muted" }] },
      { role: "Keys", choices: [{ instrument: "Clavinet-style percussive keyboard", recipe: "keys_clav_synth", capabilityNote: "Operator approximation, not a Clavinet preset" }] },
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
  rnb: {
    label: "R&B",
    aliases: ["R&B", "R and B", "rhythm and blues"],
    parts: [
      {
        role: "Bass",
        choices: [
          { instrument: "electric bass", recipe: "pop_bass", sourcePreference: "sample", when: "a live/band or Neo-Soul arrangement" },
          { instrument: "808 or sub bass", recipe: "hiphop_808_bass", when: "a modern/trap production" },
        ],
      },
      { role: "Keys", choices: [{ instrument: "Rhodes-style tine electric keyboard", recipe: "keys_rhodes_synth", capabilityNote: "Operator approximation, not a sampled Rhodes" }] },
      { role: "Piano", choices: [{ instrument: "piano", recipe: "keys_piano_sample" }] },
      { role: "Guitar", choices: [{ instrument: "clean electric guitar", recipe: "guitar_clean" }] },
      { role: "Pad", choices: [{ instrument: "warm pad", recipe: "pad_warm" }] },
      { role: "Lead", choices: [{ instrument: "clean rounded synth lead", recipe: "lead_clean" }] },
    ],
    subgenres: [
      {
        label: "Modern R&B",
        aliases: ["modern r&b", "contemporary r&b", "modern r and b"],
        overrides: [{ role: "Bass", choices: [{ instrument: "808 or sub bass", recipe: "hiphop_808_bass" }] }],
      },
      {
        label: "Neo-Soul",
        aliases: ["neo-soul", "neo soul", "neosoul"],
        overrides: [
          { role: "Bass", choices: [{ instrument: "electric bass", recipe: "pop_bass", sourcePreference: "sample", when: "a live/band arrangement" }] },
          { role: "Keys", choices: [{ instrument: "FM/electric keyboard", recipe: "keys_dx7_synth", capabilityNote: "DX7-style approximation; use only when this timbre fits, not as a guaranteed Rhodes preset" }] },
        ],
      },
      {
        label: "Trap-influenced R&B",
        aliases: ["trap r&b", "r&b trap", "trap soul", "trap r and b"],
        overrides: [{ role: "Bass", choices: [{ instrument: "808 or sub bass", recipe: "hiphop_808_bass" }] }],
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
  const parts = profile.parts.map(formatPart).join("; ") || "no profile-specific mappings";
  const subgenres = profile.subgenres.map(formatSubgenre).join(". ");
  return `${profile.label} aliases: ${profile.aliases.join(", ")}. Role-to-sound mappings: ${parts}.${subgenres ? ` ${subgenres}.` : ""}`;
}

/** Build the prompt section from the same recipe catalog used by apply_sound_recipe. */
export function genreInstrumentProfilePrompt(): string {
  const profiles = Object.values(GENRE_INSTRUMENT_PROFILES).map(formatProfile);
  return [
    `Genre-to-instrument profiles for new parts only: ${profiles.join(" ")}`,
    "Use profiles only to choose an instrument or timbre for a role already selected by the user or arrangement.",
    "Never add, omit, require, or forbid parts because of a genre profile; profiles are not a role whitelist.",
    "An explicit subgenre overrides the parent genre for listed roles; inherit the parent profile for roles it does not change.",
    "If no listed subgenre matches, retain the parent genre profile and do not guess a subgenre override.",
    "For an unlisted role, keep the selected role and use normal role-specific defaults or current Set context; ask only when that role's sound remains unclear.",
    "When a listed sample is unavailable, use its declared synth fallback and explain the approximation.",
    "Do not invent a recipe or imply an unsupported genre-specific sound.",
  ].join(" ");
}
