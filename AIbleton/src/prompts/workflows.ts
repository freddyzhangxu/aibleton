import { SYSTEM_PROMPT } from "./system.js";

const OPTIONAL_WORKFLOW_HEADINGS = [
  "Goals (tasks that change the Set)",
  "Plans (multi-step tasks)",
  "Making music that actually produces sound",
  "Sequencing an Ableton Move (hardware) from Live",
  "Move file transfer (WiFi, stock firmware API — pairing required once)",
  "Samples and audio files",
  "AI audio generation",
  "Swing and groove",
  "Controlling instruments and effects (Operator, Auto Filter, …)",
  "Compression and sidechain",
  "Song analysis (read-only)",
  "Vocal Assist (a recorded vocal, optionally compared with an original vocal)",
  "Arranging the Set",
] as const;

const WORKFLOW_INTENTS: Array<{ heading: string; match: RegExp }> = [
  {
    heading: "Making music that actually produces sound",
    match: /\b(?:create|make|write|compose|program|build|produce|add|insert|generate|sequence)\b.{0,60}\b(?:song|music|track|part|bass(?:line)?|lead|melody|drum|beat|groove|chord|notes?|clip|loop|instrument|keys?|piano|guitar|pad|pluck|synth)\b|\b(?:song|track|part|bassline|melody|drum pattern|beat|groove|chords?|clip|loop)\b.{0,40}\b(?:create|make|write|compose|program|build|produce|add|insert|generate|sequence)\b|\b(?:mach(?:e|en)?|schreib(?:e|en)?|komponier(?:e|en)?|programmier(?:e|en)?|bau(?:e|en)?|produzier(?:e|en)?|erstelle|erzeuge|sequenzier(?:e|en)?)\b.{0,60}\b(?:song|stück|track|teil|basslinie|bass|melodie|schlagzeug|beat|groove|akkord|noten|clip|loop|instrument|tasten|klavier|gitarre|pad|pluck|synth)\b|\b(?:crée|créer|fais|faire|écris|écrire|compose|composer|programme|programmer|construis|construire|produis|produire|ajoute|ajouter|génère|générer|séquence|séquencer)\b.{0,60}\b(?:chanson|morceau|piste|partie|basse|mélodie|batterie|rythme|accord|notes?|clip|boucle|instrument|clavier|piano|guitare|pad|pluck|synthé)\b|\b(?:crea|crear|haz|hacer|escribe|escribir|compón|componer|programa|programar|construye|construir|produce|producir|añade|agrega|genera|generar|secuencia|secuenciar)\b.{0,60}\b(?:canción|tema|pista|parte|bajo|melodía|batería|ritmo|acorde|notas?|clip|bucle|instrumento|teclas|piano|guitarra|pad|pluck|sinte)\b|\b(?:crea|creare|fai|fare|scrivi|scrivere|componi|comporre|programma|programmare|costruisci|costruire|produci|produrre|aggiungi|genera|generare|sequenzia|sequenziare)\b.{0,60}\b(?:canzone|brano|traccia|parte|basso|melodia|batteria|ritmo|accordo|note|clip|loop|strumento|tastiera|piano|chitarra|pad|pluck|synth)\b|(?:écris|écrire|écrivez|écrivez-moi|composer|composez|crée|créer|ajoute|ajouter|générer).{0,60}(?:chanson|morceau|piste|partie|basse|mélodie|batterie|rythme|accord|note|clip|boucle|instrument|clavier|piano|guitare|pad|pluck|synthé)|(?:ベース|メロディ|ドラム|ビート|グルーヴ|コード|ノート|クリップ|ループ|楽器|鍵盤|ピアノ|ギター|パッド|シンセ).{0,30}(?:作って|作成|作る|書いて|書く|追加|生成|編曲|打ち込む)|(?:制作|創作|编写|写|書いて|書く|添加|追加|创建|作成|作って|作る|生成|编程|打ち込む|編曲|新建|做).{0,30}(?:歌曲|音乐|乐曲|曲子|鼓|节奏|旋律|贝斯|和弦|片段|Loop|音符|铺底|主音|乐器|音色|曲|楽曲|トラック|パート|ベース|メロディ|ドラム|ビート|グルーヴ|コード|ノート|クリップ|ループ|楽器|鍵盤|ピアノ|ギター|パッド|シンセ)/i,
  },
  { heading: "Sequencing an Ableton Move (hardware) from Live", match: /\bableton\s+move\b|\bmove\s+hardware\b|Ableton Move|移动硬件/i },
  { heading: "Move file transfer (WiFi, stock firmware API — pairing required once)", match: /\bableton\s+move\b|\bmove\s+(?:set|sample|file|device|hardware)\b|Ableton Move|移动硬件/i },
  { heading: "Samples and audio files", match: /sample|audio file|loop|stem|one-shot|Splice|échantillon|boucle|muestra|campione|サンプル|音声ファイル|ループ|ステム|采样|音频文件|循环|分轨/i },
  { heading: "AI audio generation", match: /AI[- ]generated audio|generate audio|générer.*audio|generar.*audio|generare.*audio|KI.*Audio|AI生成音频|AI 音频|生成音频/i },
  { heading: "Swing and groove", match: /swing|groove|schwung|groove|swing|balan[çc]o|ritmo|schwing|スウィング|グルーヴ|摆动|律动/i },
  { heading: "Controlling instruments and effects (Operator, Auto Filter, …)", match: /device|effect|plugin|parameter|operator|filter|compressor|volume|pan|send|gerät|effekt|parameter|lautstärke|panorama|appareil|effet|paramètre|volume|dispositivo|efecto|parámetro|volumen|dispositivo|effetto|parametro|volume|デバイス|エフェクト|パラメータ|音量|パン|センド|设备|效果器|参数|音量|声像|发送/i },
  { heading: "Compression and sidechain", match: /compress|sidechain|duck|kompress|compresseur|compresión|compressore|圧縮|コンプレッサー|压缩|侧链/i },
  { heading: "Song analysis (read-only)", match: /analy[sz]e|analysier|analyse|analysieren|analyser|analiza|analizar|analizza|analizzare|review|diagnos|inspect|what does .*sound|mix|misch|mezcla|mixage|mixaggio|thin bass|kick lacks|分析|解析|审查|诊断|检查|听感|混音|低频|鼓组/i },
  { heading: "Vocal Assist (a recorded vocal, optionally compared with an original vocal)", match: /vocal|voice|sing(?:er|ing)?|gesang|stimme|voix|chant|voz|canto|voce|cantare|ボーカル|歌声|人声|演唱/i },
  { heading: "Arranging the Set", match: /arrang|structure|section|clip map|arrangier|arrangieren|arranger|estructura|arrangement|struttura|arrangiamento|構成|アレンジ|编曲|段落|结构|片段排列/i },
];

const SET_EDIT_INTENT = /\b(?:set|change|adjust|add|create|make|write|compose|program|build|produce|delete|remove|replace|swap|insert|clear|arrange|move|load|import|generate|raise|lower|increase|decrease|tweak|boost|tighten|brighten|widen|soften|mach(?:e|en)?|schreib(?:e|en)?|erstelle|füge|ändere|stelle|crée|fais|écris|ajoute|modifie|crea|haz|escribe|añade|agrega|cambia|imposta|cambia|aggiungi|scrivi|crea)\b|(?:écris|écrire|crée|créer|ajoute|ajouter|設定|調整|追加|変更|削除|作成|生成|作って|作る|書いて|追加|创建|制作|编写|写|添加|删除|替换|调整|设置)/i;

interface WorkflowSection {
  heading: string;
  text: string;
}

interface WorkflowLayout {
  prefix: string;
  tail: string;
  sections: WorkflowSection[];
}

function readWorkflowLayout(): WorkflowLayout | null {
  const starts = OPTIONAL_WORKFLOW_HEADINGS
    .map((heading) => ({ heading, start: SYSTEM_PROMPT.indexOf(`\n\n${heading}:\n`) }))
    .sort((a, b) => a.start - b.start);
  const tailStart = SYSTEM_PROMPT.indexOf("\n\nArtist memory:");
  if (tailStart < 0 || starts.some(({ start }) => start < 0)) return null;
  const sorted = starts.filter(({ start }) => start < tailStart);
  if (sorted.length !== OPTIONAL_WORKFLOW_HEADINGS.length) return null;
  return {
    prefix: SYSTEM_PROMPT.slice(0, sorted[0].start),
    tail: SYSTEM_PROMPT.slice(tailStart),
    sections: sorted.map(({ heading, start }, index) => ({
      heading,
      text: SYSTEM_PROMPT.slice(start, sorted[index + 1]?.start ?? tailStart),
    })),
  };
}

const WORKFLOW_LAYOUT = readWorkflowLayout();

export interface WorkflowSelection {
  prompt: string;
  sectionChars: Record<string, number>;
}

function fullPrompt(): WorkflowSelection {
  return {
    prompt: SYSTEM_PROMPT,
    sectionChars: { full: SYSTEM_PROMPT.length },
  };
}

export function selectWorkflowRules(userText: string, simpleEdit?: "tempo" | "mixer"): WorkflowSelection {
  if (!WORKFLOW_LAYOUT) return fullPrompt();
  if (!userText.trim() && !simpleEdit) return fullPrompt();
  const matches = WORKFLOW_INTENTS.filter(({ match }) => match.test(userText));
  const hasEditIntent = !simpleEdit && SET_EDIT_INTENT.test(userText);
  // Unknown wording keeps the complete playbook. Specialize only when intent is clear.
  if (!matches.length && !simpleEdit && !hasEditIntent) return fullPrompt();
  const wanted = new Set(matches.map(({ heading }) => heading));
  if (hasEditIntent) {
    wanted.add("Goals (tasks that change the Set)");
    wanted.add("Plans (multi-step tasks)");
  }
  const selected = WORKFLOW_LAYOUT.sections.filter(({ heading }) => wanted.has(heading));
  return {
    prompt: WORKFLOW_LAYOUT.prefix + selected.map(({ text }) => text).join("") + WORKFLOW_LAYOUT.tail,
    sectionChars: Object.fromEntries(selected.map(({ heading, text }) => [heading, text.length])),
  };
}

