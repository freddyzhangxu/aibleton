/**
 * Per-turn authorization for destructive Live operations. This deliberately
 * errs on the side of refusing: broad cleanup wording must never become a
 * license for the model to choose what to delete. A direct replacement of a
 * named device is deliberately equivalent to deletion permission for a
 * device only — it is not a license to remove other object kinds.
 */
import { commonText } from "../i18n/common.js";
export type DeleteKind =
  | "track"
  | "scene"
  | "device"
  | "arrangement_clip"
  | "session_clip";

export const DELETE_TOOL_KINDS: Readonly<Record<string, DeleteKind>> = {
  delete_track: "track",
  delete_scene: "scene",
  delete_device: "device",
  replace_device: "device",
  delete_drum_pad_device: "device",
  delete_arrangement_clip: "arrangement_clip",
  delete_session_clip: "session_clip",
};

export type DeleteAuthorization = ReadonlySet<DeleteKind>;

const DELETE_VERB = /(?:\b(?:delete|remove|erase|trash)\b|删除|删掉|删去|移除)/i;
const NEGATED_DESTRUCTIVE_ACTION = new RegExp([
  String.raw`\b(?:do not|don't|dont|never)\s+(?:delete|remove|erase|trash|replace|swap|switch)\b`,
  String.raw`\bno\s+(?:reemplaz\w*|sustitu\w*|cambi\w*|elimin\w*|borr\w*)\b`,
  String.raw`\bne\s+(?:pas\s+)?(?:remplac\w*|substitu\w*|chang\w*|supprim\w*)\b`,
  String.raw`\b(?:remplac\w*|substitu\w*|chang\w*|supprim\w*)\b[\s\S]{0,40}\b(?:pas|jamais)\b`,
  String.raw`\b(?:nicht|kein(?:e|en|er|es)?)\s+(?:ersetz\w*|austausch\w*|tausch\w*|wechsel\w*|lösch\w*)\b`,
  String.raw`\b(?:ersetz\w*|austausch\w*|tausch\w*|wechsel\w*|lösch\w*)\b[\s\S]{0,40}\b(?:nicht|kein(?:e|en|er|es)?)\b`,
  String.raw`\b(?:não|nao)\s+(?:substitu\w*|troc\w*|mud\w*|remov\w*|exclu\w*)\b`,
  String.raw`\bnon\s+(?:sostitui\w*|cambi\w*|scambi\w*|elimin\w*)\b`,
  String.raw`(?:不要|別|别|不)[\s\S]{0,80}?(?:删除|删掉|删去|移除|替换|替代|换成|改成|改用)`,
  String.raw`(?:置き換え|差し替え|入れ替え|交換|変更|切り替え|削除)[^。.!?\n]{0,40}(?:ない|ません|しない|禁止)`,
  String.raw`(?:교체|대체|바꾸|변경|삭제)[^.!?\n]{0,40}(?:않|말|마|금지)`,
].join("|"), "iu");
const DEVICE_SOURCE_PATTERN =
  /(?:\b(?:devices?|instruments?|plugins?|effects?|analog|operator|wavetable|drift|meld|collision|tension|simpler|sampler|impulse|drum rack|instrument rack|audio effect rack|midi effect rack|eq eight|auto filter|compressor|reverb|delay)\b|设备|插件|效果器|乐器)/i;
const DEVICE_REPLACEMENT_REQUEST = new RegExp([
  String.raw`\b(?:replace|replacing|replaced|swap|swapping|switch|switching|substitute|substituting|change|changing|convert|converting|turn)\b[\s\S]{0,160}\b(?:with|to|for|into|by)\b\s*\S`,
  String.raw`\b(?:reemplaz\w*|sustitu\w*|cambi\w*|intercambi\w*)\b[\s\S]{0,160}\b(?:con|por|a)\b\s*\S`,
  String.raw`\b(?:remplac\w*|substitu\w*|chang\w*|échang\w*)\b[\s\S]{0,160}\b(?:par|avec|pour|en)\b\s*\S`,
  String.raw`\b(?:ersetz\w*|austausch\w*|tausch\w*|wechsel\w*)\b[\s\S]{0,160}\b(?:durch|gegen|mit)\b\s*\S`,
  String.raw`\b(?:substitu\w*|troc\w*|mud\w*|troqu\w*)\b[\s\S]{0,160}\b(?:por|com|para)\b\s*\S`,
  String.raw`\b(?:sostitui\w*|cambi\w*|scambi\w*)\b[\s\S]{0,160}\b(?:con|per|in)\b\s*\S`,
  String.raw`(?:换成|换为|改成|改为|改用)\s*(?:为)?\s*\S`,
  String.raw`(?:用|以)\s*\S[\s\S]{0,160}(?:替换|替代)\s*\S`,
  String.raw`(?:安全)?(?:替换|替代)\s*(?:为|成)\s*\S`,
  String.raw`(?:替换|替代)\s*\S[\s\S]{0,160}(?:为|成)\s*\S`,
  String.raw`(?:置き換|差し替|入れ替|交換|変更|切り替)\S*[\s\S]{0,160}(?:に|へ)\s*\S`,
  String.raw`\S+(?:を|は)\s*\S+(?:に|へ)\s*(?:置き換|差し替|入れ替|交換|変更|切り替)\S*`,
  String.raw`\S+(?:을|를|은|는)\s*\S+(?:로|으로)\s*(?:교체|대체|바꾸|변경)\S*`,
].join("|"), "iu");
const KIND_PATTERNS: Readonly<Record<DeleteKind, RegExp>> = {
  track: /(?:\btracks?\b|轨道)/i,
  scene: /(?:\bscenes?\b|场景)/i,
  device: DEVICE_SOURCE_PATTERN,
  arrangement_clip: /(?:\barrangement\s*(?:clips?|clip)?\b|编排(?:区)?\s*(?:clip|片段))/i,
  session_clip: /(?:\bsession\s*(?:clips?|clip)?\b|会话(?:视图)?\s*(?:clip|片段))/i,
};

/** Extract only explicit, object-kind-specific delete permission from one
 * user message. A direct replacement of a named device authorizes device
 * deletion; a negative destructive statement invalidates the whole request
 * rather than trying to infer grammar across clauses. */
export function deleteAuthorizationFor(userText: string): DeleteAuthorization {
  if (NEGATED_DESTRUCTIVE_ACTION.test(userText)) return new Set();
  const kinds = new Set<DeleteKind>();
  const deviceMentioned = DEVICE_SOURCE_PATTERN.test(userText);
  const replacementRequested = deviceMentioned && DEVICE_REPLACEMENT_REQUEST.test(userText);
  if (DELETE_VERB.test(userText)) {
    for (const [kind, pattern] of Object.entries(KIND_PATTERNS) as [DeleteKind, RegExp][]) {
      // In a direct device replacement, track/scene/clip words describe the
      // device's owner or location, not additional deletion targets.
      if (replacementRequested && kind !== "device") continue;
      if (pattern.test(userText)) kinds.add(kind);
    }
  }
  if (replacementRequested) kinds.add("device");
  return kinds;
}

export function isDeleteTool(name: string): name is keyof typeof DELETE_TOOL_KINDS {
  return name in DELETE_TOOL_KINDS;
}

export function deleteToolIsAuthorized(name: string, authorization: DeleteAuthorization | undefined): boolean {
  return isDeleteTool(name) && authorization?.has(DELETE_TOOL_KINDS[name]) === true;
}

export function deleteAuthorizationError(name: string, language?: string): { error: string; delete_authorization_required: true } {
  const kind = isDeleteTool(name) ? DELETE_TOOL_KINDS[name].replaceAll("_", " ") : "object";
  return {
    error: commonText(language ?? "zh", "deleteNotAuthorized", kind),
    delete_authorization_required: true,
  };
}
