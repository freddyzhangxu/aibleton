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
const NEGATED_DESTRUCTIVE_ACTION =
  /(?:\b(?:do not|don't|dont|never)\s+(?:delete|remove|erase|trash|replace|swap|switch)\b|(?:不要|别|不)[\s\S]{0,80}?(?:删除|删掉|删去|移除|替换|替代|换成|改成|改用))/i;
const DEVICE_SOURCE_PATTERN =
  /(?:\b(?:devices?|instruments?|plugins?|effects?|operator|wavetable|simpler|sampler|impulse|drum rack|instrument rack|audio effect rack|midi effect rack|eq eight|auto filter|compressor|reverb|delay)\b|设备|插件|效果器|乐器)/i;
const DEVICE_REPLACEMENT_REQUEST =
  /(?:\b(?:replace|swap|switch)\b[\s\S]{0,160}\b(?:with|to|for)\s+\S|(?:换成|改成|改用)\s*(?:为)?\s*\S|(?:用|以)\s*\S[\s\S]{0,160}(?:替换|替代)\s*\S|(?:安全)?(?:替换|替代)\s*(?:为|成)\s*\S|(?:替换|替代)\s*\S[\s\S]{0,160}(?:为|成)\s*\S)/i;
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
  if (DELETE_VERB.test(userText)) {
    for (const [kind, pattern] of Object.entries(KIND_PATTERNS) as [DeleteKind, RegExp][]) {
      if (pattern.test(userText)) kinds.add(kind);
    }
  }
  if (DEVICE_SOURCE_PATTERN.test(userText) && DEVICE_REPLACEMENT_REQUEST.test(userText)) kinds.add("device");
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
