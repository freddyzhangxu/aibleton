export type SoundRecipeId =
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
  | "funk_slap_bass"
  | "pluck_bright"
  | "pluck_warm"
  | "pluck_bell"
  | "pluck_guitar"
  | "pluck_kalimba";

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
  id: SoundRecipeId;
  role: "bass" | "pluck";
  label: string;
  genreTerms: readonly string[];
  source: "sample" | "synth" | "contextual";
  sampleQueries: readonly string[];
  /** Filename evidence required before a local sample is accepted. */
  sampleEvidence?: readonly string[];
  instrument?: string;
  fallbackInstrument: string;
  targets: Readonly<Record<string, readonly RecipeParameterTarget[]>>;
};

const simpleSampleEnvelope = (
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

const simplePluckEnvelope = (
  attack: number,
  decay: number,
  sustain: number,
  release: number,
): readonly RecipeParameterTarget[] => [
  { id: "attack", kind: "numeric", aliases: ["Amp Attack", "Volume Attack"], normalizedValue: attack },
  { id: "decay", kind: "numeric", aliases: ["Amp Decay", "Volume Decay"], normalizedValue: decay },
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

const wavetableBrightPluckControls: readonly RecipeParameterTarget[] = [
  { id: "amp_attack", kind: "numeric", aliases: ["Amp Attack"], normalizedValue: 0.0005 },
  { id: "amp_decay", kind: "numeric", aliases: ["Amp Decay"], normalizedValue: 0.22 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Amp Sustain"], normalizedValue: 0.08 },
  { id: "amp_release", kind: "numeric", aliases: ["Amp Release"], normalizedValue: 0.03 },
  { id: "filter_frequency", kind: "numeric", aliases: ["Filter Frequency", "Filter Freq"], normalizedValue: 0.65 },
  { id: "filter_resonance", kind: "numeric", aliases: ["Filter Resonance", "Filter Res"], normalizedValue: 0.08 },
];

const driftWarmPluckControls: readonly RecipeParameterTarget[] = [
  { id: "amp_attack", kind: "numeric", aliases: ["Env 1 Attack"], normalizedValue: 0.002 },
  { id: "amp_decay", kind: "numeric", aliases: ["Env 1 Decay"], normalizedValue: 0.3 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Env 1 Sustain"], normalizedValue: 0.12 },
  { id: "amp_release", kind: "numeric", aliases: ["Env 1 Release"], normalizedValue: 0.05 },
  { id: "filter_frequency", kind: "numeric", aliases: ["LP Freq"], normalizedValue: 0.3 },
  { id: "filter_resonance", kind: "numeric", aliases: ["LP Res"], normalizedValue: 0.03 },
];

const operatorBellPluckControls: readonly RecipeParameterTarget[] = [
  { id: "amp_attack", kind: "numeric", aliases: ["Ae Attack"], normalizedValue: 0.0001 },
  { id: "amp_decay", kind: "numeric", aliases: ["Ae Decay"], normalizedValue: 0.18 },
  { id: "amp_sustain", kind: "numeric", aliases: ["Ae Sustain"], normalizedValue: 0.02 },
  { id: "amp_release", kind: "numeric", aliases: ["Ae Release"], normalizedValue: 0.04 },
  { id: "osc_b_coarse", kind: "numeric", aliases: ["B Coarse", "Osc B Coarse", "Oscillator B Coarse"], normalizedValue: 0.16 },
  { id: "osc_b_level", kind: "numeric", aliases: ["B Level", "Osc B Level", "Oscillator B Level"], normalizedValue: 0.42 },
  { id: "filter_frequency", kind: "numeric", aliases: ["Filter Frequency", "Filter Freq"], normalizedValue: 0.55 },
];

export const SOUND_RECIPES: Readonly<Record<SoundRecipeId, SoundRecipe>> = {
  rock_bass: {
    id: "rock_bass",
    role: "bass",
    label: "Rock / band electric bass",
    genreTerms: ["rock", "band", "pop rock", "摇滚", "乐队"],
    source: "sample",
    sampleQueries: ["picked electric bass", "plucked bass", "rock bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0002, 0.72, 0.003),
      Operator: operatorBassControls,
    },
  },
  reggae_bass: {
    id: "reggae_bass",
    role: "bass",
    label: "Reggae warm electric bass",
    genreTerms: ["reggae", "雷鬼"],
    source: "sample",
    sampleQueries: ["reggae bass", "fingered bass", "muted electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0005, 0.9, 0.005),
      Operator: operatorBassControls,
    },
  },
  pop_bass: {
    id: "pop_bass",
    role: "bass",
    label: "Pop clean supportive bass",
    genreTerms: ["pop", "pop rock", "dance pop", "流行"],
    source: "contextual",
    sampleQueries: ["clean electric bass", "pop bass", "synth bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0002, 0.8, 0.003),
      Operator: operatorBassControls,
    },
  },
  electronic_bass: {
    id: "electronic_bass",
    role: "bass",
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
    role: "bass",
    label: "Hip-hop / R&B 808 or sub bass",
    genreTerms: ["hip-hop", "hip hop", "rap", "r&b", "808", "嘻哈", "说唱"],
    source: "sample",
    sampleQueries: ["808 bass", "808 sub", "sub bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0, 1, 0.002),
      Operator: operatorBassControls,
    },
  },
  jazz_bass: {
    id: "jazz_bass",
    role: "bass",
    label: "Jazz upright / double bass",
    genreTerms: ["jazz", "straight-ahead jazz", "爵士"],
    source: "sample",
    sampleQueries: ["upright bass", "double bass", "jazz bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0003, 0.82, 0.004),
      Operator: warmOperatorBassControls,
    },
  },
  jazz_fusion_bass: {
    id: "jazz_fusion_bass",
    role: "bass",
    label: "Jazz fusion fingerstyle electric bass",
    genreTerms: ["jazz fusion", "fusion", "flatwound bass", "爵士融合"],
    source: "sample",
    sampleQueries: ["flatwound electric bass", "fingerstyle electric bass", "jazz electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0002, 0.76, 0.003),
      Operator: warmOperatorBassControls,
    },
  },
  bossa_bass: {
    id: "bossa_bass",
    role: "bass",
    label: "Bossa Nova soft upright bass",
    genreTerms: ["bossa nova", "bossanova", "bossa", "波萨诺瓦", "巴萨诺瓦"],
    source: "sample",
    sampleQueries: ["bossa upright bass", "upright bass", "mellow electric bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0004, 0.8, 0.003),
      Operator: warmOperatorBassControls,
    },
  },
  funk_bass: {
    id: "funk_bass",
    role: "bass",
    label: "Funk fingerstyle electric bass",
    genreTerms: ["funk", "fingerstyle funk", "放克"],
    source: "sample",
    sampleQueries: ["funk finger bass", "fingerstyle bass", "funk bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.0001, 0.78, 0.002),
      Operator: punchyOperatorBassControls,
    },
  },
  funk_pick_bass: {
    id: "funk_pick_bass",
    role: "bass",
    label: "Funk picked electric bass",
    genreTerms: ["funk pick", "picked funk bass", "拨片放克"],
    source: "sample",
    sampleQueries: ["picked electric bass", "funk pick bass", "pick bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0.00005, 0.72, 0.0015),
      Operator: punchyOperatorBassControls,
    },
  },
  funk_slap_bass: {
    id: "funk_slap_bass",
    role: "bass",
    label: "Funk slap electric bass",
    genreTerms: ["funk slap", "slap bass", "slap funk", "击弦放克"],
    source: "sample",
    sampleQueries: ["slap electric bass", "funk slap bass", "slap bass"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simpleSampleEnvelope(0, 0.66, 0.001),
      Operator: punchyOperatorBassControls,
    },
  },
  pluck_bright: {
    id: "pluck_bright",
    role: "pluck",
    label: "Bright short synth Pluck",
    genreTerms: ["house", "techno", "bright", "short", "punchy", "明亮", "短促"],
    source: "synth",
    sampleQueries: [],
    instrument: "Wavetable",
    fallbackInstrument: "Wavetable",
    targets: { Wavetable: wavetableBrightPluckControls },
  },
  pluck_warm: {
    id: "pluck_warm",
    role: "pluck",
    label: "Warm soft synth Pluck",
    genreTerms: ["jazz", "bossa", "warm", "soft", "mellow", "温暖", "柔和"],
    source: "synth",
    sampleQueries: [],
    instrument: "Drift",
    fallbackInstrument: "Drift",
    targets: { Drift: driftWarmPluckControls },
  },
  pluck_bell: {
    id: "pluck_bell",
    role: "pluck",
    label: "Bell-like metallic synth Pluck",
    genreTerms: ["pop", "cinematic", "bell", "metallic", "fm", "铃声感", "金属感"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
    targets: { Operator: operatorBellPluckControls },
  },
  pluck_guitar: {
    id: "pluck_guitar",
    role: "pluck",
    label: "Guitar Pluck sample",
    genreTerms: ["guitar", "nylon guitar", "muted guitar", "吉他", "尼龙弦"],
    source: "sample",
    sampleQueries: ["nylon guitar", "muted guitar", "clean electric guitar", "guitar"],
    sampleEvidence: ["guitar", "gtr"],
    fallbackInstrument: "Drift",
    targets: {
      Simpler: simplePluckEnvelope(0.0003, 0.24, 0.1, 0.04),
      Drift: driftWarmPluckControls,
    },
  },
  pluck_kalimba: {
    id: "pluck_kalimba",
    role: "pluck",
    label: "Kalimba / thumb piano Pluck sample",
    genreTerms: ["kalimba", "mbira", "thumb piano", "卡林巴", "拇指琴"],
    source: "sample",
    sampleQueries: ["kalimba", "mbira", "thumb piano"],
    sampleEvidence: ["kalimba", "mbira", "thumb piano"],
    fallbackInstrument: "Operator",
    targets: {
      Simpler: simplePluckEnvelope(0.0001, 0.14, 0.03, 0.035),
      Operator: operatorBellPluckControls,
    },
  },
};

export const SOUND_RECIPE_IDS = Object.keys(SOUND_RECIPES) as SoundRecipeId[];
