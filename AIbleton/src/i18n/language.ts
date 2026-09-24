/** Turn-scoped reply-language resolution. Pure and dependency-free. */

export const SUPPORTED_LANGUAGES = ["zh", "en", "de", "fr", "ja", "es", "it"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguageSource = "message" | "panel" | "default";

const SUPPORTED = new Set<string>(SUPPORTED_LANGUAGES);

export function normalizeLanguage(language?: string): SupportedLanguage {
  const code = (language ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.has(code) ? (code as SupportedLanguage) : "en";
}

export interface ResolveReplyLanguageInput {
  text: string;
  panelLanguage?: string;
}

export interface ResolvedReplyLanguage {
  language: SupportedLanguage;
  source: LanguageSource;
  confidence: number;
}

export interface TurnLanguageContext {
  uiLanguage: SupportedLanguage;
  replyLanguage: SupportedLanguage;
  searchLanguage: SupportedLanguage;
  source: LanguageSource;
  confidence: number;
}

const MUSIC_TOKENS = new Set([
  "bpm", "midi", "audio", "clip", "clips", "track", "tracks", "live", "ableton",
  "kick", "snare", "clap", "hat", "hihat", "bass", "lead", "pad", "arp", "organ",
  "guitar", "drums", "drum", "operator", "wavetable", "simpler", "sampler", "loop",
  "intro", "drop", "break", "breakdown", "build", "outro", "chorus", "verse",
  "major", "minor", "db", "hz", "khz", "wav", "aiff", "mp3",
]);

const WORD_HINTS: Record<Exclude<SupportedLanguage, "zh" | "ja">, Set<string>> = {
  en: new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
    "is", "are", "this", "that", "please", "make", "create", "add", "remove", "change",
    "harder", "softer", "louder", "quieter", "more", "less", "keep", "use", "move",
    "play", "fix", "turn", "want", "need", "should", "can", "without", "from", "done", "completed",
    "translate", "into", "english", "summarize", "analyze", "explain", "review", "what", "why", "how",
    "named", "called", "okay", "thanks", "thank", "yes", "sure", "hello", "hi", "continue", "again",
  ]),
  de: new Set([
    "der", "die", "das", "den", "dem", "ein", "eine", "einen", "und", "oder", "aber",
    "zu", "von", "im", "in", "auf", "für", "mit", "ist", "sind", "bitte", "mach",
    "mache", "erstelle", "füge", "entferne", "ändere", "mehr", "weniger", "lauter",
    "leiser", "behalte", "verwende", "ich", "möchte", "ohne", "nicht", "fertig", "abgeschlossen",
    "übersetze", "übersetzen", "englisch", "ins", "danke", "ja", "nein", "weiter", "hallo",
  ]),
  fr: new Set([
    "le", "la", "les", "un", "une", "des", "du", "et", "ou", "mais", "de", "dans",
    "sur", "pour", "avec", "est", "sont", "merci", "fais", "faire", "crée", "créer",
    "ajoute", "supprime", "change", "plus", "moins", "fort", "doucement", "garde",
    "utilise", "je", "veux", "sans", "pas", "cette", "ce", "terminé", "terminée",
    "traduis", "traduire", "traduisez", "anglais", "résume", "résumer", "explique", "expliquer", "en",
    "oui", "bonjour", "salut", "accord",
  ]),
  es: new Set([
    "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "pero", "de",
    "del", "en", "para", "por", "con", "es", "son", "porfavor", "favor", "haz", "hacer",
    "crea", "crear", "añade", "agrega", "quita", "elimina", "cambia", "más", "menos",
    "fuerte", "suave", "mantén", "usa", "quiero", "necesito", "sin", "no", "este", "esta", "listo", "hecho",
    "traduce", "traducir", "inglés", "resume", "resumir", "explica", "explicar",
    "gracias", "hola", "vale", "sí", "continúa", "continua",
  ]),
  it: new Set([
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "o", "ma", "di",
    "del", "nel", "in", "per", "con", "è", "sono", "perfavore", "favore", "fai", "fare",
    "crea", "creare", "aggiungi", "rimuovi", "elimina", "cambia", "più", "meno", "forte",
    "piano", "mantieni", "usa", "voglio", "serve", "senza", "non", "questo", "questa", "fatto", "completato",
    "traduci", "tradurre", "inglese", "riassumi", "riassumere", "spiega", "spiegare",
    "grazie", "ciao", "certo", "sì", "continua",
  ]),
};

function cleanForDetection(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/)[^\s]+/g, " ")
    .replace(/\b[\w-]+_[\w-]+\b/g, " ");
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function latinScores(text: string, tokens: string[]): Record<Exclude<SupportedLanguage, "zh" | "ja">, number> {
  const scores = { en: 0, de: 0, fr: 0, es: 0, it: 0 };
  for (const token of tokens) {
    for (const language of Object.keys(WORD_HINTS) as (keyof typeof WORD_HINTS)[]) {
      if (WORD_HINTS[language].has(token)) scores[language] += 2;
    }
    if (/^(?:ge\w+|\w+(?:ung|keit|lich|isch|chen))$/u.test(token)) scores.de += 0.6;
    if (/\w+(?:tion|ment|ique|eux|euse)$/u.test(token)) scores.fr += 0.5;
    if (/\w+(?:ción|mente|ando|iendo|ado|ido)$/u.test(token)) scores.es += 0.6;
    if (/\w+(?:zione|mente|ando|endo|ato|ito)$/u.test(token)) scores.it += 0.6;
    if (/\w+(?:ing|ed|er|ly)$/u.test(token)) scores.en += 0.4;
  }
  scores.de += countMatches(text, /[äöüß]/giu) * 2.5;
  scores.es += countMatches(text, /[ñ¿¡]/giu) * 3 + countMatches(text, /[áíóú]/giu) * 1.5;
  scores.fr += countMatches(text, /[çœàâêëîïôûùÿ]/giu) * 2 + countMatches(text, /[éè]/giu);
  scores.it += countMatches(text, /[ìò]/giu) * 2 + countMatches(text, /[àèù]/giu);
  return scores;
}

export function resolveReplyLanguage(input: ResolveReplyLanguageInput): ResolvedReplyLanguage {
  const panel = input.panelLanguage && SUPPORTED.has(input.panelLanguage.toLowerCase().split(/[-_]/)[0])
    ? normalizeLanguage(input.panelLanguage)
    : undefined;
  const fallback = (): ResolvedReplyLanguage => panel
    ? { language: panel, source: "panel", confidence: 1 }
    : { language: "en", source: "default", confidence: 1 };

  const clean = cleanForDetection(input.text).normalize("NFKC");
  const kana = countMatches(clean, /[\u3040-\u30ff]/gu);
  const han = countMatches(clean, /[\u3400-\u9fff]/gu);

  const tokens = (clean.toLocaleLowerCase("und").match(/\p{L}+/gu) ?? [])
    .filter((token) => token.length > 1 && !MUSIC_TOKENS.has(token));
  const scores = latinScores(clean.toLocaleLowerCase("und"), tokens);
  const ranked = (Object.entries(scores) as [Exclude<SupportedLanguage, "zh" | "ja">, number][])
    .sort((a, b) => b[1] - a[1]);
  const [bestLanguage, bestScore] = ranked[0];
  const secondScore = ranked[1][1];
  const margin = bestScore - secondScore;
  const latinLetters = countMatches(clean, /\p{Script=Latin}/gu);
  const nonLatinScriptLetters = kana + han;
  // Briefly referenced Asian-script names or lyric fragments should not overrule a clear
  // Latin-language request. Asian-script prose still wins when it is the main text.
  const latinRequestIsClear =
    bestScore >= 4 && margin >= 1 && latinLetters >= Math.max(8, nonLatinScriptLetters * 1.5);

  if (kana > 0 && !latinRequestIsClear) return { language: "ja", source: "message", confidence: 1 };
  if (han > 0 && !latinRequestIsClear) {
    return { language: "zh", source: "message", confidence: Math.min(1, 0.8 + han * 0.05) };
  }
  if (!tokens.length || bestScore < 2 || margin < 1) return fallback();
  return {
    language: bestLanguage,
    source: "message",
    confidence: Math.min(0.99, 0.55 + Math.min(0.3, margin * 0.08) + Math.min(0.14, bestScore * 0.02)),
  };
}

export function resolveTurnLanguage(input: ResolveReplyLanguageInput): TurnLanguageContext {
  const uiLanguage = normalizeLanguage(input.panelLanguage);
  const reply = resolveReplyLanguage(input);
  return {
    uiLanguage,
    replyLanguage: reply.language,
    searchLanguage: reply.language,
    source: reply.source,
    confidence: reply.confidence,
  };
}

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  zh: "Chinese", en: "English", de: "German", fr: "French", ja: "Japanese", es: "Spanish", it: "Italian",
};

const MIN_REPLY_LETTERS = 4;
const MIN_JA_REPLY_HAN_LETTERS = 6;
export const MAX_REPLY_LANGUAGE_CORRECTIONS = 2;

function letterCount(text: string): number {
  return [...text.matchAll(/\p{L}/gu)].length;
}

function replySegments(text: string): string[] {
  const clean = cleanForDetection(text).normalize("NFKC");
  return clean
    .split(/[\r\n]+|(?<=[。！？!?；;])\s*|(?<=[.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter((segment) => letterCount(segment) >= MIN_REPLY_LETTERS);
}

function isMeaningfulReplyLanguage(
  text: string,
  expected: SupportedLanguage,
  detected: ResolvedReplyLanguage,
): boolean {
  const letters = letterCount(text);
  if (letters < MIN_REPLY_LETTERS) return false;

  // Han-only Japanese labels and headings are indistinguishable from short
  // Chinese fragments. Require a longer Chinese-looking segment when the
  // expected language is Japanese; real mixed prose still exceeds this bound.
  if (
    expected === "ja" &&
    detected.language === "zh" &&
    !/[\u3040-\u30ff]/u.test(text) &&
    letters < MIN_JA_REPLY_HAN_LETTERS
  ) {
    return false;
  }
  return true;
}

/** Only a confident, different language triggers a bounded provider rewrite. */
export function replyNeedsLanguageCorrection(text: string, expectedLanguage?: string): boolean {
  const expected = normalizeLanguage(expectedLanguage);
  const clean = cleanForDetection(text).normalize("NFKC");
  if (letterCount(clean) < MIN_REPLY_LETTERS) {
    const hasHan = /[\u3400-\u9fff]/u.test(clean);
    const hasKana = /[\u3040-\u30ff]/u.test(clean);
    const hasLatin = /\p{Script=Latin}/u.test(clean);
    // A very short Han-only answer is still a language mismatch for Latin
    // targets. Keep Japanese's Han-only ambiguity exception.
    return expected !== "zh" && expected !== "ja" && hasHan && !hasKana && !hasLatin;
  }

  const detected = resolveReplyLanguage({ text: clean, panelLanguage: expected });
  if (
    detected.source === "message" &&
    detected.language !== expected &&
    detected.confidence >= 0.7 &&
    isMeaningfulReplyLanguage(clean, expected, detected)
  ) {
    return true;
  }

  const segments = replySegments(clean);
  if (segments.length < 2) return false;

  const segmentLanguages = segments.map((segment) => ({
    text: segment,
    detected: resolveReplyLanguage({ text: segment, panelLanguage: expected }),
  }));
  const hasExpectedLanguage = segmentLanguages.some(({ detected: segment }) =>
    segment.source === "message" && segment.language === expected && segment.confidence >= 0.7,
  );
  if (!hasExpectedLanguage) return false;

  return segmentLanguages.some(({ text: segmentText, detected: segment }) =>
    segment.source === "message" &&
    segment.language !== expected &&
    segment.confidence >= 0.7 &&
    isMeaningfulReplyLanguage(segmentText, expected, segment),
  );
}

export function languageCorrectionPrompt(language?: string): string {
  const code = normalizeLanguage(language);
  return (
    `Rewrite your previous answer entirely in ${LANGUAGE_NAMES[code]} (${code}). ` +
    `Preserve facts, numbers, track names, tool names, and formatting. Do not call any tools.`
  );
}
