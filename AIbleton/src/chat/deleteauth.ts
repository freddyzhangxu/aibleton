/**
 * Per-turn authorization for destructive Live operations. This deliberately
 * errs on the side of refusing: broad cleanup wording must never become a
 * license for the model to choose what to delete.
 */
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
  delete_arrangement_clip: "arrangement_clip",
  delete_session_clip: "session_clip",
};

export type DeleteAuthorization = ReadonlySet<DeleteKind>;

const DELETE_VERB = /(?:\b(?:delete|remove|erase|trash)\b|删除|删掉|删去|移除)/i;
const NEGATED_DELETE = /(?:\b(?:do not|don't|dont|never)\s+(?:delete|remove|erase|trash)\b|(?:不要|别|不)(?:删除|删掉|删去|移除))/i;
const KIND_PATTERNS: Readonly<Record<DeleteKind, RegExp>> = {
  track: /(?:\btracks?\b|轨道)/i,
  scene: /(?:\bscenes?\b|场景)/i,
  device: /(?:\bdevices?\b|设备|插件|效果器|乐器)/i,
  arrangement_clip: /(?:\barrangement\s*(?:clips?|clip)?\b|编排(?:区)?\s*(?:clip|片段))/i,
  session_clip: /(?:\bsession\s*(?:clips?|clip)?\b|会话(?:视图)?\s*(?:clip|片段))/i,
};

/** Extract only explicit, object-kind-specific delete permission from one
 * user message. A negative deletion statement invalidates the whole request
 * rather than trying to infer grammar across clauses. */
export function deleteAuthorizationFor(userText: string): DeleteAuthorization {
  if (!DELETE_VERB.test(userText) || NEGATED_DELETE.test(userText)) return new Set();
  const kinds = new Set<DeleteKind>();
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS) as [DeleteKind, RegExp][]) {
    if (pattern.test(userText)) kinds.add(kind);
  }
  return kinds;
}

export function isDeleteTool(name: string): name is keyof typeof DELETE_TOOL_KINDS {
  return name in DELETE_TOOL_KINDS;
}

export function deleteToolIsAuthorized(name: string, authorization: DeleteAuthorization | undefined): boolean {
  return isDeleteTool(name) && authorization?.has(DELETE_TOOL_KINDS[name]) === true;
}

export function deleteAuthorizationError(name: string): { error: string; delete_authorization_required: true } {
  const kind = isDeleteTool(name) ? DELETE_TOOL_KINDS[name].replaceAll("_", " ") : "object";
  return {
    error:
      `删除未执行：请在本条消息中明确指定要删除的 ${kind}；` +
      "“清理一下”或“删掉不用的东西”不构成删除授权。 / Deletion was not executed: explicitly name the " +
      `${kind} to delete in this message; broad cleanup requests are not authorization.`,
    delete_authorization_required: true,
  };
}
