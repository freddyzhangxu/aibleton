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
  return recipe.source === "sample" ? "sample" : recipe.source === "synth" ? `synth ${recipe.instrument ?? recipe.fallbackInstrument}` : "contextual source";
}

function formatChoice(choice: GenreInstrumentChoice): string {
  const condition = choice.when ? ` when ${choice.when}` : "";
  if (!choice.recipe) return `${choice.sourcePreference ?? "source not specified"}${condition}`;

  const recipe = SOUND_RECIPES[choice.recipe];
  const source = choice.sourcePreference === "sample"
    ? "sample"
    : choice.sourcePreference === "synth"
      ? `synth ${recipe.instrument ?? recipe.fallbackInstrument}`
      : sourceLabel(choice.recipe);
  return `${source}${condition}`;
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
  return `${profile.label} aliases: ${profile.aliases.join(", ")}. Role-to-source mappings: ${parts}.${subgenres ? ` ${subgenres}.` : ""}`;
}

const LOCALIZED_GENRE_ALIASES: Record<string, string[]> = {
  pop: ["流行", "流行音乐"],
  rock: ["摇滚", "摇滚乐"],
  jazz: ["爵士", "爵士乐"],
  funk: ["放克", "芬克"],
  "r&b": ["节奏布鲁斯", "节奏蓝调", "节奏与布鲁斯"],
  "pop rock": ["流行摇滚"],
  "dance pop": ["舞曲流行", "舞曲流行乐"],
  "synth pop": ["合成器流行", "合成器流行乐"],
  "piano rock": ["钢琴摇滚"],
  "synth rock": ["合成器摇滚"],
  "straight-ahead jazz": ["传统爵士", "正统爵士"],
  "jazz fusion": ["爵士融合", "融合爵士"],
  "bossa nova": ["波萨诺瓦", "巴萨诺瓦", "巴西波萨诺瓦"],
  "funk slap": ["拍击放克"],
  "funk pick": ["拨片放克"],
  "disco funk": ["迪斯科放克"],
  "modern r&b": ["现代节奏布鲁斯", "现代节奏蓝调"],
  "neo-soul": ["新灵魂乐", "新灵魂"],
  "trap-influenced r&b": ["陷阱节奏布鲁斯", "陷阱灵魂乐"],
};

function inputAliases(label: string, aliases: readonly string[]): string[] {
  return [...aliases, ...(LOCALIZED_GENRE_ALIASES[label.toLocaleLowerCase()] ?? [])];
}

/** Build source-only drum guidance for drum-related requests. */
export function genreDrumProfilePrompt(userText = ""): string {
  const normalized = userText.toLocaleLowerCase();
  const isDrumRequest = /\b(?:drums?|kick|snare|clap|hi[ -]?hat|percussion|beat|groove|rhythm)\b|鼓|底鼓|大鼓|军鼓|小鼓|踩镲|打击乐|节奏|律动/i.test(normalized);
  if (!isDrumRequest) return "";

  return [
    "Drum kits and individual drum samples are sample sources. Choose a factory kit or local sample source that matches the user's explicit source/style request; genre is a source-selection hint only.",
    "Do not prescribe per-pad synthesis or specific envelope, filter, or effect settings; let the model use musical judgment for how the selected sample source fits the part.",
    "Drum guidance does not require or prohibit parts or patterns; choose them from the request and current Set.",
    "For an existing Set, call get_drum_pad_sample on the target pad before replacing; call replace_drum_pad_sample only for the requested pad. A genre profile alone never authorizes sample replacement.",
    "If no sample source is available, keep the current pad sample and explain the limitation.",
  ].join(" ");
}

/** Build the prompt section from the same recipe catalog used by apply_sound_recipe. */
export function genreInstrumentProfilePrompt(userText = "", selectedRoles?: readonly GenrePartRole[]): string {
  const normalized = userText.toLocaleLowerCase();
  const roles = selectedRoles ? new Set(selectedRoles) : undefined;
  const allProfiles = Object.values(GENRE_INSTRUMENT_PROFILES);
  const profiles = (normalized
    ? allProfiles.filter((profile) =>
        [...inputAliases(profile.label, profile.aliases), ...profile.subgenres.flatMap((subgenre) => inputAliases(subgenre.label, subgenre.aliases))]
          .some((alias) => normalized.includes(alias.toLocaleLowerCase())),
      )
    : allProfiles
  ).map((profile) => {
    const parts = roles ? profile.parts.filter((part) => roles.has(part.role)) : profile.parts;
    const subgenres = normalized
      ? profile.subgenres.filter((subgenre) =>
          inputAliases(subgenre.label, subgenre.aliases).some((alias) => normalized.includes(alias.toLocaleLowerCase())),
        )
      : profile.subgenres;
    return {
      ...profile,
      parts,
      subgenres: roles
        ? subgenres.map((subgenre) => ({
            ...subgenre,
            overrides: subgenre.overrides.filter((part) => roles.has(part.role)),
          })).filter((subgenre) => subgenre.overrides.length > 0)
        : subgenres,
    };
  }).filter((profile) => !roles || profile.parts.length > 0 || profile.subgenres.length > 0)
    .map(formatProfile);
  return [
    profiles.length ? `Genre-to-instrument profiles for new parts only: ${profiles.join(" ")}` : "",
    "Use profiles as suggestions only for sample versus synth or a named built-in synth source; they do not prescribe timbre design.",
    "Profiles do not mandate or exclude roles; adapt the lineup to the genre, subgenre, user intent, mood, and current Set.",
    "An explicit subgenre overrides the parent genre only for source selections it changes; inherit the parent profile's source choice otherwise.",
    "If no listed subgenre matches, retain the parent genre profile and do not guess a subgenre override.",
    "For an unlisted role, choose a suitable source using musical judgment, available instruments, and current Set context; ask only when the source remains unclear.",
    "When a selected sample source is unavailable, choose a suitable synth source and explain the substitution.",
  ].filter(Boolean).join(" ");
}
