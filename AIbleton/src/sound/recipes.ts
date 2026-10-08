export type BassRecipeId =
  | "rock_bass"
  | "reggae_bass"
  | "pop_bass"
  | "electronic_bass"
  | "hiphop_808_bass"
  | "jazz_bass"
  | "jazz_fusion_bass"
  | "bossa_bass"
  | "funk_bass"
  | "funk_pick_bass"
  | "funk_slap_bass";

export type NumericRecipeTarget = {
  id: string;
  kind: "numeric";
  aliases: readonly string[];
  normalizedValue: number;
};

export type EnumRecipeTarget = {
  id: string;
  kind: "enum";
  aliases: readonly string[];
  optionAliases: readonly string[];
};

export type RecipeParameterTarget = NumericRecipeTarget | EnumRecipeTarget;

export type SoundRecipe = {
  id: BassRecipeId;
  label: string;
  genreTerms: readonly string[];
  source: "sample" | "synth" | "contextual";
  sampleQueries: readonly string[];
  instrument?: string;
  fallbackInstrument: string;
  targets: Readonly<Record<string, readonly RecipeParameterTarget[]>>;
};

const simpleBassEnvelope = (
  attack: number,
  sustain: number,
  release: number,
): readonly RecipeParameterTarget[] => [
  // Live's envelope times can span many seconds, so bass transients use small
  // fractions of the device range while sustain stays near its target level.
  { id: "attack", kind: "numeric", aliases: ["Amp Attack", "Volume Attack"], normalizedValue: attack },
  { id: "sustain", kind: "numeric", aliases: ["Amp Sustain", "Volume Sustain"], normalizedValue: sustain },
  { id: "release", kind: "numeric", aliases: ["Amp Release", "Volume Release"], normalizedValue: release },
];

const operatorBassControls: readonly RecipeParameterTarget[] = [
  { id: "filter_frequency", kind: "numeric", aliases: ["Filter Frequency", "Filter Freq"], normalizedValue: 0.04 },
  { id: "filter_resonance", kind: "numeric", aliases: ["Filter Resonance", "Filter Res"], normalizedValue: 0.12 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Amp Sustain", "Volume Sustain"], normalizedValue: 0.34 },
  { id: "amp_release", kind: "numeric", aliases: ["Amp Release", "Volume Release"], normalizedValue: 0.003 },
];

const warmOperatorBassControls: readonly RecipeParameterTarget[] = [
  { id: "filter_frequency", kind: "numeric", aliases: ["Filter Frequency", "Filter Freq"], normalizedValue: 0.025 },
  { id: "filter_resonance", kind: "numeric", aliases: ["Filter Resonance", "Filter Res"], normalizedValue: 0.05 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Amp Sustain", "Volume Sustain"], normalizedValue: 0.38 },
  { id: "amp_release", kind: "numeric", aliases: ["Amp Release", "Volume Release"], normalizedValue: 0.003 },
];

const punchyOperatorBassControls: readonly RecipeParameterTarget[] = [
  { id: "filter_frequency", kind: "numeric", aliases: ["Filter Frequency", "Filter Freq"], normalizedValue: 0.08 },
  { id: "filter_resonance", kind: "numeric", aliases: ["Filter Resonance", "Filter Res"], normalizedValue: 0.16 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Amp Sustain", "Volume Sustain"], normalizedValue: 0.32 },
  { id: "amp_release", kind: "numeric", aliases: ["Amp Release", "Volume Release"], normalizedValue: 0.0015 },
];

export const BASS_SOUND_RECIPES: Readonly<Record<BassRecipeId, SoundRecipe>> = {
  rock_bass: {
    id: "rock_bass",
    label: "Rock / band electric bass",
    genreTerms: ["rock", "band", "pop rock", "摇滚", "乐队"],
    source: "sample",
    sampleQueries: ["picked electric bass", "plucked bass", "rock bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0002, 0.72, 0.003),
      Operator: operatorBassControls,
    },
  },
  reggae_bass: {
    id: "reggae_bass",
    label: "Reggae warm electric bass",
    genreTerms: ["reggae", "雷鬼"],
    source: "sample",
    sampleQueries: ["reggae bass", "fingered bass", "muted electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0005, 0.9, 0.005),
      Operator: operatorBassControls,
    },
  },
  pop_bass: {
    id: "pop_bass",
    label: "Pop clean supportive bass",
    genreTerms: ["pop", "pop rock", "dance pop", "流行"],
    source: "contextual",
    sampleQueries: ["clean electric bass", "pop bass", "synth bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0002, 0.8, 0.003),
      Operator: operatorBassControls,
    },
  },
  electronic_bass: {
    id: "electronic_bass",
    label: "Electronic / dance synth bass",
    genreTerms: ["electronic", "dance", "house", "techno", "edm", "电子", "电音", "舞曲"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
    targets: { Operator: operatorBassControls },
  },
  hiphop_808_bass: {
    id: "hiphop_808_bass",
    label: "Hip-hop / R&B 808 or sub bass",
    genreTerms: ["hip-hop", "hip hop", "rap", "r&b", "808", "嘻哈", "说唱"],
    source: "sample",
    sampleQueries: ["808 bass", "808 sub", "sub bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0, 1, 0.002),
      Operator: operatorBassControls,
    },
  },
  jazz_bass: {
    id: "jazz_bass",
    label: "Jazz upright / double bass",
    genreTerms: ["jazz", "straight-ahead jazz", "爵士"],
    source: "sample",
    sampleQueries: ["upright bass", "double bass", "jazz bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0003, 0.82, 0.004),
      Operator: warmOperatorBassControls,
    },
  },
  jazz_fusion_bass: {
    id: "jazz_fusion_bass",
    label: "Jazz fusion fingerstyle electric bass",
    genreTerms: ["jazz fusion", "fusion", "flatwound bass", "爵士融合"],
    source: "sample",
    sampleQueries: ["flatwound electric bass", "fingerstyle electric bass", "jazz electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0002, 0.76, 0.003),
      Operator: warmOperatorBassControls,
    },
  },
  bossa_bass: {
    id: "bossa_bass",
    label: "Bossa Nova soft upright bass",
    genreTerms: ["bossa nova", "bossanova", "bossa", "波萨诺瓦", "巴萨诺瓦"],
    source: "sample",
    sampleQueries: ["bossa upright bass", "upright bass", "mellow electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0004, 0.8, 0.003),
      Operator: warmOperatorBassControls,
    },
  },
  funk_bass: {
    id: "funk_bass",
    label: "Funk fingerstyle electric bass",
    genreTerms: ["funk", "fingerstyle funk", "放克"],
    source: "sample",
    sampleQueries: ["funk finger bass", "fingerstyle bass", "funk bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.0001, 0.78, 0.002),
      Operator: punchyOperatorBassControls,
    },
  },
  funk_pick_bass: {
    id: "funk_pick_bass",
    label: "Funk picked electric bass",
    genreTerms: ["funk pick", "picked funk bass", "拨片放克"],
    source: "sample",
    sampleQueries: ["picked electric bass", "funk pick bass", "pick bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0.00005, 0.72, 0.0015),
      Operator: punchyOperatorBassControls,
    },
  },
  funk_slap_bass: {
    id: "funk_slap_bass",
    label: "Funk slap electric bass",
    genreTerms: ["funk slap", "slap bass", "slap funk", "击弦放克"],
    source: "sample",
    sampleQueries: ["slap electric bass", "funk slap bass", "slap bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleBassEnvelope(0, 0.66, 0.001),
      Operator: punchyOperatorBassControls,
    },
  },
};

export const BASS_RECIPE_IDS = Object.keys(BASS_SOUND_RECIPES) as BassRecipeId[];
