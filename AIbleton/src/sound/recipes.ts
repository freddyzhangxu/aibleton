export type SoundRecipeId =
  | "source_bass_sample"
  | "source_bass_synth"
  | "source_pad_sample"
  | "source_pad_synth"
  | "source_pluck_sample"
  | "source_pluck_synth"
  | "source_guitar_sample"
  | "source_guitar_synth"
  | "source_lead_sample"
  | "source_lead_synth"
  | "source_keys_sample"
  | "source_keys_synth"
  | "source_piano_sample"
  | "source_piano_synth"
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
  | "pluck_kalimba"
  | "guitar_acoustic"
  | "guitar_clean"
  | "guitar_muted"
  | "guitar_overdrive"
  | "pad_warm"
  | "pad_airy"
  | "pad_dark"
  | "lead_clean"
  | "lead_analog"
  | "lead_aggressive"
  | "pad_warm_sample"
  | "pad_airy_sample"
  | "pad_dark_sample"
  | "pluck_bright_sample"
  | "pluck_warm_sample"
  | "pluck_bell_sample"
  | "lead_clean_sample"
  | "lead_analog_sample"
  | "lead_aggressive_sample"
  | "keys_piano_sample"
  | "keys_piano_grand_sample"
  | "keys_piano_felt_sample"
  | "keys_dx7_synth"
  | "keys_rhodes_synth"
  | "keys_clav_synth";

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
  role: "bass" | "pad" | "pluck" | "guitar" | "lead" | "keys" | "piano";
  label: string;
  genreTerms: readonly string[];
  source: "sample" | "synth" | "contextual";
  sampleQueries: readonly string[];
  /** Filename evidence required before a local sample is accepted. */
  sampleEvidence?: readonly string[];
  /** Sample playback intent for new role-specific sample recipes. */
  samplePlayback?: "loop" | "one_shot";
  /** Every group must have one matching term in the filename stem. */
  sampleEvidenceGroups?: readonly (readonly string[])[];
  /** Matching any of these filename-stem terms rejects the sample. */
  sampleExcludeEvidence?: readonly string[];
  instrument?: string;
  fallbackInstrument: string;
};

export const SOUND_RECIPES: Readonly<Record<SoundRecipeId, SoundRecipe>> = {
  source_bass_sample: {
    id: "source_bass_sample", role: "bass", label: "Bass sample source", genreTerms: [],
    source: "sample", sampleQueries: ["bass"], fallbackInstrument: "Operator",
  },
  source_bass_synth: {
    id: "source_bass_synth", role: "bass", label: "Bass synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Operator",
  },
  source_pad_sample: {
    id: "source_pad_sample", role: "pad", label: "Pad sample source", genreTerms: [],
    source: "sample", sampleQueries: ["pad", "texture", "atmosphere", "drone"], samplePlayback: "loop", fallbackInstrument: "Wavetable",
  },
  source_pad_synth: {
    id: "source_pad_synth", role: "pad", label: "Pad synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Wavetable",
  },
  source_pluck_sample: {
    id: "source_pluck_sample", role: "pluck", label: "Pluck sample source", genreTerms: [],
    source: "sample", sampleQueries: ["pluck", "mallet", "marimba", "glockenspiel", "kalimba"], samplePlayback: "one_shot", fallbackInstrument: "Wavetable",
  },
  source_pluck_synth: {
    id: "source_pluck_synth", role: "pluck", label: "Pluck synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Wavetable",
  },
  source_guitar_sample: {
    id: "source_guitar_sample", role: "guitar", label: "Guitar sample source", genreTerms: [],
    source: "sample", sampleQueries: ["guitar"], samplePlayback: "one_shot", fallbackInstrument: "Drift",
  },
  source_guitar_synth: {
    id: "source_guitar_synth", role: "guitar", label: "Guitar synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Drift",
  },
  source_lead_sample: {
    id: "source_lead_sample", role: "lead", label: "Lead sample source", genreTerms: [],
    source: "sample", sampleQueries: ["lead", "synth lead", "keyboard lead"], samplePlayback: "one_shot", fallbackInstrument: "Drift",
  },
  source_lead_synth: {
    id: "source_lead_synth", role: "lead", label: "Lead synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Drift",
  },
  source_keys_sample: {
    id: "source_keys_sample", role: "keys", label: "Keys sample source", genreTerms: [],
    source: "sample", sampleQueries: ["keyboard", "keys", "electric piano"], samplePlayback: "one_shot", fallbackInstrument: "Operator",
  },
  source_keys_synth: {
    id: "source_keys_synth", role: "keys", label: "Keys synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Operator",
  },
  source_piano_sample: {
    id: "source_piano_sample", role: "piano", label: "Piano sample source", genreTerms: [],
    source: "sample", sampleQueries: ["piano"], samplePlayback: "one_shot", fallbackInstrument: "Operator",
  },
  source_piano_synth: {
    id: "source_piano_synth", role: "piano", label: "Piano synth source", genreTerms: [],
    source: "synth", sampleQueries: [], fallbackInstrument: "Operator",
  },
  rock_bass: {
    id: "rock_bass",
    role: "bass",
    label: "Rock / band electric bass",
    genreTerms: ["rock", "band", "pop rock", "摇滚", "乐队"],
    source: "sample",
    sampleQueries: ["picked electric bass", "plucked bass", "rock bass"],
    fallbackInstrument: "Operator",
  },
  reggae_bass: {
    id: "reggae_bass",
    role: "bass",
    label: "Reggae warm electric bass",
    genreTerms: ["reggae", "雷鬼"],
    source: "sample",
    sampleQueries: ["reggae bass", "fingered bass", "muted electric bass"],
    fallbackInstrument: "Operator",
  },
  pop_bass: {
    id: "pop_bass",
    role: "bass",
    label: "Pop clean supportive bass",
    genreTerms: ["pop", "pop rock", "dance pop", "流行"],
    source: "contextual",
    sampleQueries: ["clean electric bass", "pop bass", "synth bass"],
    fallbackInstrument: "Operator",
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
  },
  hiphop_808_bass: {
    id: "hiphop_808_bass",
    role: "bass",
    label: "Hip-hop / R&B 808 or sub bass",
    genreTerms: ["hip-hop", "hip hop", "rap", "r&b", "808", "嘻哈", "说唱"],
    source: "sample",
    sampleQueries: ["808 bass", "808 sub", "sub bass"],
    fallbackInstrument: "Operator",
  },
  jazz_bass: {
    id: "jazz_bass",
    role: "bass",
    label: "Jazz upright / double bass",
    genreTerms: ["jazz", "straight-ahead jazz", "爵士"],
    source: "sample",
    sampleQueries: ["upright bass", "double bass", "jazz bass"],
    fallbackInstrument: "Operator",
  },
  jazz_fusion_bass: {
    id: "jazz_fusion_bass",
    role: "bass",
    label: "Jazz fusion fingerstyle electric bass",
    genreTerms: ["jazz fusion", "fusion", "flatwound bass", "爵士融合"],
    source: "sample",
    sampleQueries: ["flatwound electric bass", "fingerstyle electric bass", "jazz electric bass"],
    fallbackInstrument: "Operator",
  },
  bossa_bass: {
    id: "bossa_bass",
    role: "bass",
    label: "Bossa Nova soft upright bass",
    genreTerms: ["bossa nova", "bossanova", "bossa", "波萨诺瓦", "巴萨诺瓦"],
    source: "sample",
    sampleQueries: ["bossa upright bass", "upright bass", "mellow electric bass"],
    fallbackInstrument: "Operator",
  },
  funk_bass: {
    id: "funk_bass",
    role: "bass",
    label: "Funk fingerstyle electric bass",
    genreTerms: ["funk", "fingerstyle funk", "放克"],
    source: "sample",
    sampleQueries: ["funk finger bass", "fingerstyle bass", "funk bass"],
    fallbackInstrument: "Operator",
  },
  funk_pick_bass: {
    id: "funk_pick_bass",
    role: "bass",
    label: "Funk picked electric bass",
    genreTerms: ["funk pick", "picked funk bass", "拨片放克"],
    source: "sample",
    sampleQueries: ["picked electric bass", "funk pick bass", "pick bass"],
    fallbackInstrument: "Operator",
  },
  funk_slap_bass: {
    id: "funk_slap_bass",
    role: "bass",
    label: "Funk slap electric bass",
    genreTerms: ["funk slap", "slap bass", "slap funk", "击弦放克"],
    source: "sample",
    sampleQueries: ["slap electric bass", "funk slap bass", "slap bass"],
    fallbackInstrument: "Operator",
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
  },
  guitar_acoustic: {
    id: "guitar_acoustic",
    role: "guitar",
    label: "Acoustic / nylon Guitar sample",
    genreTerms: ["acoustic guitar", "nylon guitar", "bossa", "folk", "原声吉他", "尼龙弦吉他"],
    source: "sample",
    sampleQueries: ["nylon guitar", "acoustic guitar", "steel string guitar"],
    sampleEvidenceGroups: [["guitar", "gtr"], ["nylon", "acoustic", "steelstring"]],
    samplePlayback: "one_shot",
    fallbackInstrument: "Drift",
  },
  guitar_clean: {
    id: "guitar_clean",
    role: "guitar",
    label: "Clean electric / hollowbody Guitar sample",
    genreTerms: ["clean electric guitar", "hollowbody guitar", "jazz guitar", "clean guitar", "清音电吉他"],
    source: "sample",
    sampleQueries: ["clean electric guitar", "hollowbody guitar", "jazz guitar", "clean guitar"],
    sampleEvidenceGroups: [["guitar", "gtr"], ["clean", "hollowbody", "hollow", "electric"]],
    sampleExcludeEvidence: ["distort", "overdrive", "fuzz"],
    samplePlayback: "one_shot",
    fallbackInstrument: "Drift",
  },
  guitar_muted: {
    id: "guitar_muted",
    role: "guitar",
    label: "Muted / Funk Guitar sample",
    genreTerms: ["muted guitar", "funk guitar", "chank guitar", "闷音吉他", "放克吉他"],
    source: "sample",
    sampleQueries: ["muted guitar", "mute guitar", "guitar mute", "funk guitar", "muted electric guitar", "chank guitar"],
    sampleEvidenceGroups: [["guitar", "gtr"], ["muted", "mute", "chank"]],
    samplePlayback: "one_shot",
    fallbackInstrument: "Drift",
  },
  guitar_overdrive: {
    id: "guitar_overdrive",
    role: "guitar",
    label: "Overdriven / distorted Guitar sample",
    genreTerms: ["overdrive guitar", "distorted guitar", "rock guitar", "crunch guitar", "失真吉他", "过载吉他"],
    source: "sample",
    sampleQueries: ["overdrive guitar", "distorted guitar", "guitar distorted", "distortion guitar", "guitar distortion", "distorted electric guitar", "rock guitar", "crunch guitar"],
    sampleEvidenceGroups: [["guitar", "gtr"], ["overdrive", "overdriven", "distorted", "distortion", "crunch"]],
    samplePlayback: "one_shot",
    instrument: "Wavetable",
    fallbackInstrument: "Wavetable",
  },
  pad_warm: {
    id: "pad_warm",
    role: "pad",
    label: "Warm soft Pad",
    genreTerms: ["warm", "soft", "mellow", "house", "techno", "温暖", "柔和", "铺底"],
    source: "synth",
    sampleQueries: [],
    instrument: "Drift",
    fallbackInstrument: "Drift",
  },
  pad_airy: {
    id: "pad_airy",
    role: "pad",
    label: "Airy bright Pad",
    genreTerms: ["airy", "shimmering", "bright", "ambient", "空灵", "闪耀", "明亮", "氛围"],
    source: "synth",
    sampleQueries: [],
    instrument: "Wavetable",
    fallbackInstrument: "Wavetable",
  },
  pad_dark: {
    id: "pad_dark",
    role: "pad",
    label: "Dark cinematic Pad",
    genreTerms: ["dark", "cinematic", "drone", "暗色", "电影感", "持续音"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
  },
  lead_clean: {
    id: "lead_clean",
    role: "lead",
    label: "Clean rounded Lead",
    genreTerms: ["clean", "clear", "rounded", "pop", "干净", "清晰", "圆润", "流行"],
    source: "synth",
    sampleQueries: [],
    instrument: "Drift",
    fallbackInstrument: "Drift",
  },
  lead_analog: {
    id: "lead_analog",
    role: "lead",
    label: "Warm analog-style Lead",
    genreTerms: ["analog", "warm", "vintage", "funk", "disco", "模拟", "温暖", "复古", "放克", "迪斯科"],
    source: "synth",
    sampleQueries: [],
    instrument: "Drift",
    fallbackInstrument: "Drift",
  },
  lead_aggressive: {
    id: "lead_aggressive",
    role: "lead",
    label: "Bright aggressive Lead",
    genreTerms: ["aggressive", "bright", "punchy", "house", "techno", "强劲", "明亮", "有冲击力"],
    source: "synth",
    sampleQueries: [],
    instrument: "Wavetable",
    fallbackInstrument: "Wavetable",
  },
  pad_warm_sample: {
    id: "pad_warm_sample",
    role: "pad",
    label: "Warm soft looped Pad sample",
    genreTerms: ["warm", "soft", "mellow", "house", "techno", "温暖", "柔和", "铺底"],
    source: "sample",
    sampleQueries: ["warm pad loop", "soft pad loop", "analog pad loop"],
    samplePlayback: "loop",
    sampleEvidenceGroups: [["pad", "atmosphere", "texture", "drone"], ["warm", "soft", "mellow", "analog"]],
    fallbackInstrument: "Drift",
  },
  pad_airy_sample: {
    id: "pad_airy_sample",
    role: "pad",
    label: "Airy shimmering looped Pad sample",
    genreTerms: ["airy", "shimmering", "bright", "ambient", "空灵", "闪耀", "明亮", "氛围"],
    source: "sample",
    sampleQueries: ["airy pad loop", "shimmering pad loop", "ambient pad loop"],
    samplePlayback: "loop",
    sampleEvidenceGroups: [["pad", "atmosphere", "texture"], ["airy", "shimmer", "shimmering", "bright"]],
    fallbackInstrument: "Wavetable",
  },
  pad_dark_sample: {
    id: "pad_dark_sample",
    role: "pad",
    label: "Dark cinematic looped Pad sample",
    genreTerms: ["dark", "cinematic", "drone", "暗色", "电影感", "持续音"],
    source: "sample",
    sampleQueries: ["dark pad loop", "cinematic pad loop", "dark drone loop"],
    samplePlayback: "loop",
    sampleEvidenceGroups: [["pad", "drone", "texture"], ["dark", "cinematic", "moody"]],
    fallbackInstrument: "Operator",
  },
  pluck_bright_sample: {
    id: "pluck_bright_sample",
    role: "pluck",
    label: "Bright Pluck or mallet one-shot sample",
    genreTerms: ["bright", "short", "punchy", "house", "techno", "明亮", "短促", "拨弦"],
    source: "sample",
    sampleQueries: ["bright pluck", "bright mallet", "bright marimba"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["pluck", "mallet", "marimba", "glockenspiel", "kalimba"], ["bright", "crisp", "punchy", "bell"]],
    fallbackInstrument: "Wavetable",
  },
  pluck_warm_sample: {
    id: "pluck_warm_sample",
    role: "pluck",
    label: "Warm Pluck or soft guitar one-shot sample",
    genreTerms: ["warm", "soft", "mellow", "jazz", "bossa", "温暖", "柔和", "吉他"],
    source: "sample",
    sampleQueries: ["warm pluck", "soft guitar pluck", "warm kalimba"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["pluck", "guitar", "nylon", "kalimba", "mbira"], ["warm", "soft", "mellow", "nylon"]],
    fallbackInstrument: "Drift",
  },
  pluck_bell_sample: {
    id: "pluck_bell_sample",
    role: "pluck",
    label: "Bell-like Pluck or metallic mallet one-shot sample",
    genreTerms: ["bell", "metallic", "fm", "pop", "cinematic", "铃声感", "金属感"],
    source: "sample",
    sampleQueries: ["bell pluck", "metallic mallet", "bell kalimba"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["pluck", "kalimba", "mallet", "bell", "glockenspiel"], ["bell", "metallic", "tine", "bright"]],
    fallbackInstrument: "Operator",
  },
  lead_clean_sample: {
    id: "lead_clean_sample",
    role: "lead",
    label: "Clean synth or keyboard Lead one-shot sample",
    genreTerms: ["clean", "clear", "rounded", "pop", "干净", "清晰", "圆润"],
    source: "sample",
    sampleQueries: ["clean synth lead", "clear synth lead", "clean keyboard lead"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["lead", "synth lead", "mono lead", "keyboard lead"], ["clean", "clear", "rounded", "pristine"]],
    fallbackInstrument: "Drift",
  },
  lead_analog_sample: {
    id: "lead_analog_sample",
    role: "lead",
    label: "Warm analog Lead one-shot sample",
    genreTerms: ["analog", "warm", "vintage", "funk", "disco", "模拟", "温暖", "复古"],
    source: "sample",
    sampleQueries: ["analog synth lead", "warm analog lead", "vintage synth lead"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["lead", "synth lead", "mono lead"], ["analog", "vintage", "warm", "retro"]],
    fallbackInstrument: "Drift",
  },
  lead_aggressive_sample: {
    id: "lead_aggressive_sample",
    role: "lead",
    label: "Aggressive distorted Lead one-shot sample",
    genreTerms: ["aggressive", "bright", "punchy", "house", "techno", "强劲", "明亮"],
    source: "sample",
    sampleQueries: ["aggressive synth lead", "distorted synth lead", "bright mono lead"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["lead", "synth lead", "mono lead"], ["aggressive", "distorted", "dirty", "hard", "gritty"]],
    fallbackInstrument: "Wavetable",
  },
  keys_piano_sample: {
    id: "keys_piano_sample",
    role: "piano",
    label: "Piano Keys one-shot sample",
    genreTerms: ["keys", "piano", "pop", "钢琴", "键盘"],
    source: "sample",
    sampleQueries: ["grand piano", "acoustic piano", "piano keys"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["piano", "grand piano", "acoustic piano", "upright piano"]],
    fallbackInstrument: "Operator",
  },
  keys_piano_grand_sample: {
    id: "keys_piano_grand_sample",
    role: "piano",
    label: "Bright grand / acoustic Piano one-shot sample",
    genreTerms: ["grand piano", "acoustic piano", "concert piano", "明亮钢琴", "三角钢琴"],
    source: "sample",
    sampleQueries: ["grand piano", "concert grand piano", "acoustic piano"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["grand piano", "grand", "concert piano", "acoustic piano"]],
    sampleExcludeEvidence: ["felt", "upright", "toy", "electric", "rhodes"],
    fallbackInstrument: "Operator",
  },
  keys_piano_felt_sample: {
    id: "keys_piano_felt_sample",
    role: "piano",
    label: "Soft felt / upright Piano one-shot sample",
    genreTerms: ["felt piano", "upright piano", "soft piano", "warm piano", "毡音钢琴", "立式钢琴", "柔和钢琴"],
    source: "sample",
    sampleQueries: ["felt piano", "upright piano", "soft piano"],
    samplePlayback: "one_shot",
    sampleEvidenceGroups: [["piano"], ["felt", "upright", "soft", "warm"]],
    sampleExcludeEvidence: ["grand", "concert", "electric", "rhodes"],
    fallbackInstrument: "Operator",
  },
  keys_dx7_synth: {
    id: "keys_dx7_synth",
    role: "keys",
    label: "DX7-style FM / electric Keys approximation",
    genreTerms: ["DX7", "FM", "electric piano", "电钢琴", "电钢"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
  },
  keys_rhodes_synth: {
    id: "keys_rhodes_synth",
    role: "keys",
    label: "Rhodes-style tine electric Keys approximation",
    genreTerms: ["Rhodes", "tine electric piano", "electric piano", "neo-soul", "电钢琴", "罗兹电钢"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
  },
  keys_clav_synth: {
    id: "keys_clav_synth",
    role: "keys",
    label: "Clavinet-style percussive Keys approximation",
    genreTerms: ["Clavinet", "clav", "funk", "percussive keys", "击弦键盘", "克拉维键盘"],
    source: "synth",
    sampleQueries: [],
    instrument: "Operator",
    fallbackInstrument: "Operator",
  },
};

/** Public recipe choices select only role + source; legacy flavor recipes remain internal. */
export const SOURCE_RECIPE_IDS = [
  "source_bass_sample", "source_bass_synth",
  "source_pad_sample", "source_pad_synth",
  "source_pluck_sample", "source_pluck_synth",
  "source_guitar_sample", "source_guitar_synth",
  "source_lead_sample", "source_lead_synth",
  "source_keys_sample", "source_keys_synth",
  "source_piano_sample", "source_piano_synth",
] as const satisfies readonly SoundRecipeId[];

export const SOUND_RECIPE_IDS = SOURCE_RECIPE_IDS;
