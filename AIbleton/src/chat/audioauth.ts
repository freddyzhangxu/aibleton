import { commonText } from "../i18n/common.js";

// A creation verb alone never chooses an external audio generator. Resolve
// this from raw user prose, never from attached files, skills or model plans.
const AI_METHOD = /(?<![a-z])(?:AI|KI|IA)(?![a-z])|人工智能|人工智慧/i;
const SERVICE_METHOD = /(?<![a-z])(?:Stable[-\s]*Audio|ElevenLabs|MiniMax)(?![a-z])|(?:使用|调用|用)音频生成/i;
const GENERATION_REQUEST = /\b(?:generat\w*|creat\w*|mak\w*|produc\w*|compos\w*|erzeug\w*|erstell\w*|génèr\w*|génér\w*|genera\w*|crea\w*)\b|生成|制作|製作|创作|創作|编写|編寫|写|寫|作曲|编曲|編曲|作成|作って|做/i;
const AI_GENERATION_ACTION = /\b(?:generat\w*|erzeug\w*|génèr\w*|génér\w*|genera\w*)\b|生成/i;
const AUDIO_CONTENT = /\b(?:audio|music|song|loop|sample|stem|vocal|sound|track|blues|can(?:ción|zone)|chanson|morceau|audiodatei)\b|音频|音頻|音乐|音樂|歌曲|一首|采样|採樣|人声|音声|楽曲|ブルース/i;
const NEGATED_GENERATION = /(?:不要|别|不用|不使用|禁止|无需|無需).{0,24}(?:AI|KI|IA|生成|音频|音頻|MiniMax|ElevenLabs|Stable\s*Audio)|\b(?:no|not|never|without|avoid|don['’]t|do\s+not)\b.{0,30}(?:\bAI\b|\bKI\b|\bIA\b|generat|MiniMax|ElevenLabs|Stable\s*Audio)|(?:生成|作成)しない|(?:使わない|使わず)/i;
const CONSENT = /^(?:yes|yeah|ok(?:ay)?|sure|go ahead|please do|ja|oui|sí|si|はい|可以|好的?|同意|行|是的|生成吧|用音频生成吧)(?:[,，\s]*(?:用音频生成吧|生成吧))?[。.!！\s]*$/i;
const OFFER = /[?？]|\b(?:shall|would|want|should|may I|can I)\b|要不要|是否|可以吗/i;
const INFORMATION_REQUEST = /(?:设置|設定).{0,12}(?:哪里|在哪)|什么是|如何|怎么配置|\b(?:what (?:is|are)|how (?:does|do I|to)|where (?:is|are))\b/i;

/** Permission lasts for one user turn, including its existing auto-refine
 * budget. Short consent needs an explicit offer in the immediately prior
 * assistant message; a fresh song request cannot inherit that offer. */
export function audioGenerationAuthorized(userText: string, previousAssistant = ""): boolean {
  if (NEGATED_GENERATION.test(userText) || INFORMATION_REQUEST.test(userText)) return false;
  // "AI, write/compose/produce a song" addresses this assistant. Only an
  // explicit generation action or a named audio service chooses that method.
  const explicit = (text: string) => AUDIO_CONTENT.test(text) && (
    (SERVICE_METHOD.test(text) && GENERATION_REQUEST.test(text)) ||
    (AI_METHOD.test(text) && AI_GENERATION_ACTION.test(text))
  );
  if (explicit(userText)) return true;
  return CONSENT.test(userText.trim()) && explicit(previousAssistant) && OFFER.test(previousAssistant);
}

export function audioGenerationRefusal(language?: string): Record<string, unknown> {
  return {
    executed: false,
    code: "audio_generation_not_requested",
    error: commonText(language, "audioGenerationNotRequested"),
  };
}
