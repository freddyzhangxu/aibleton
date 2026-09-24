export {
  SUPPORTED_LANGUAGES,
  MAX_REPLY_LANGUAGE_CORRECTIONS,
  normalizeLanguage,
  languageCorrectionPrompt,
  replyNeedsLanguageCorrection,
  resolveReplyLanguage,
  resolveTurnLanguage,
  type LanguageSource,
  type ResolvedReplyLanguage,
  type ResolveReplyLanguageInput,
  type SupportedLanguage,
  type TurnLanguageContext,
} from "./language.js";
export { commonText, type CommonMessageKey } from "./common.js";
export { apiErrorText, type ApiErrorKind } from "./errors.js";
