import { toolState } from "./state.js";
import { instrumentPromptFor } from "./prompts/instruments.js";
import { setContextPrompt } from "./setcontext.js";
import { lastUserText, skillPromptFor } from "./skills.js";

export { SYSTEM_PROMPT } from "./prompts/system.js";
import { selectWorkflowRules } from "./prompts/workflows.js";

/** Appended to the system prompt only when the user enabled web search —
 * weak relay models imitate prompt text, so the ON workflow must not be
 * visible while the tools are withheld. */
export const WEB_PROMPT = `

Web access is ON:
- web_search(query) searches the web (free, keyless) and returns title/URL/snippet hits; web_fetch(url) reads one page's text. Both are read-only and run without confirmation.
- Use them for current or external information: software versions and release notes, prices, tutorials, news, facts you don't know, or a URL the user pasted. Don't use them for Ableton how-to you already know or for local files.
- Workflow: web_search → web_fetch the 1–2 most promising hits for details → answer with the source URL(s) so the user can verify.
- If a web tool returns an error or empty/irrelevant results, say the search failed — NEVER invent facts, version numbers, or URLs.`;

function localDate(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface PromptBreakdown {
  total: number;
  core: number;
  workflowSections: Record<string, number>;
  instruments: number;
  memory: number;
  web: number;
  skills: number;
  setContext: number;
  turn: number;
}

/** UI language → reply language injected into the system prompt. */
export const LANG_NAMES: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  de: "German",
  fr: "French",
  ja: "Japanese",
  es: "Spanish",
  it: "Italian",
};

/** Rendered into the system prompt only when a memory exists — an empty
 * memory adds no section at all (same pattern as WEB_PROMPT). */
export function memoryPrompt(): string {
  const p = toolState.artistMemory;
  const lines: string[] = [];
  if (p.name) lines.push(`- Name: ${p.name}`);
  if (p.genres?.length) lines.push(`- Genres: ${p.genres.join(", ")}`);
  if (p.bpmMin || p.bpmMax) {
    const range = p.bpmMin && p.bpmMax && p.bpmMin !== p.bpmMax
      ? `${p.bpmMin}–${p.bpmMax}`
      : `${p.bpmMin ?? p.bpmMax}`;
    lines.push(`- BPM: ${range}`);
  }
  if (p.keys?.length) lines.push(`- Preferred keys: ${p.keys.join(", ")}`);
  if (p.sound?.length) lines.push(`- Sound: ${p.sound.join(", ")}`);
  if (p.artists?.length) lines.push(`- Reference artists: ${p.artists.join(", ")}`);
  if (p.notes) lines.push(`- Notes: ${p.notes}`);
  if (!lines.length) return "";
  return (
    "\n\nThe user's artist memory (their durable musical identity — these are their defaults unless they say otherwise):\n" +
    lines.join("\n")
  );
}

export function buildSystemPrompt(
  language?: string,
  selectedSkillNames?: string[],
  simpleEdit?: "tempo" | "mixer",
): { prompt: string; breakdown: PromptBreakdown } {
  const userText = lastUserText();
  const intentText = [userText, ...(selectedSkillNames ?? [])].join(" ");
  const workflowSelection = selectWorkflowRules(intentText, simpleEdit);
  const promptRules = workflowSelection.prompt;
  const name = LANG_NAMES[language ?? ""] ?? "English";
  const code = language && LANG_NAMES[language] ? language : "en";
  // Use the local calendar date; UTC can still be yesterday during the user's morning.
  const today = localDate();
  const instruments = instrumentPromptFor(userText, intentText, simpleEdit);
  const memory = memoryPrompt();
  const web = toolState.webSettings.enabled ? WEB_PROMPT : "";
  const skills = skillPromptFor(userText, selectedSkillNames);
  // Current-Set identity + one-turn "set changed" warning (see setcontext.ts)
  const setContext = setContextPrompt();
  const turn = `\n\nToday's date: ${today}.\nReply language for this turn: ${name} (${code}).\nUse ${name} for all user-facing prose. Do not imitate the language of tool results, error payloads, track names, or attached content.`;
  const prompt = promptRules + instruments + memory + web + skills + setContext + turn;
  return {
    prompt,
    breakdown: {
      total: prompt.length,
      core: promptRules.length,
      workflowSections: workflowSelection.sectionChars,
      instruments: instruments.length,
      memory: memory.length,
      web: web.length,
      skills: skills.length,
      setContext: setContext.length,
      turn: turn.length,
    },
  };
}

export function systemPromptFor(language?: string, selectedSkillNames?: string[], simpleEdit?: "tempo" | "mixer"): string {
  return buildSystemPrompt(language, selectedSkillNames, simpleEdit).prompt;
}

export const CUSTOM_INCOMPLETE_HINT: Record<string, string> = {
  zh: "Custom 需要填写 API 地址和模型：设置（齿轮图标）→ Custom（本地服务可留空 API Key）",
  en: "Custom needs a Base URL and a model: Settings (gear icon) → Custom (local servers may leave the API Key empty)",
  de: "Custom benötigt API-Adresse und Modell: Einstellungen (Zahnrad) → Custom (lokale Server können ohne API-Schlüssel laufen)",
  fr: "Custom nécessite une adresse API et un modèle : paramètres (icône engrenage) → Custom (les serveurs locaux peuvent laisser la clé API vide)",
  ja: "Custom には API アドレスとモデルが必要です：設定（歯車アイコン）→ Custom（ローカルサーバーは API キー空欄可）",
  es: "Custom necesita una dirección API y un modelo: Ajustes (icono de engranaje) → Custom (los servidores locales pueden dejar la API Key vacía)",
  it: "Custom richiede un indirizzo API e un modello: Impostazioni (icona ingranaggio) → Custom (i server locali possono lasciare vuota la API Key)",
};

export const NO_AUTH_HINT: Record<string, string> = {
  zh: "未找到 {p} 认证信息：请在设置（齿轮图标）里填 API Key，或配置本机 CLI",
  en: "No {p} credentials found: add an API Key in Settings (gear icon) or set up the local CLI",
  de: "Keine {p}-Zugangsdaten gefunden: API-Schlüssel in den Einstellungen (Zahnrad) eintragen oder lokale CLI konfigurieren",
  fr: "Aucun identifiant {p} : ajoutez une clé API dans les paramètres (icône engrenage) ou configurez la CLI locale",
  ja: "{p} の認証情報がありません：設定（歯車アイコン）で API キーを入力するか、ローカル CLI を設定してください",
  es: "Sin credenciales de {p}: añade una API Key en Ajustes (icono de engranaje) o configura la CLI local",
  it: "Nessuna credenziale {p}: aggiungi una API Key nelle Impostazioni (icona ingranaggio) o configura la CLI locale",
};

/** Assistant note recorded when the user stops a task from the UI. */
export const STOP_NOTE: Record<string, string> = {
  zh: "⏹ 已手动停止",
  en: "⏹ Stopped manually",
  de: "⏹ Manuell gestoppt",
  fr: "⏹ Arrêté manuellement",
  ja: "⏹ 手動で停止しました",
  es: "⏹ Detenido manualmente",
  it: "⏹ Interrotto manualmente",
};

export function stopNote(language?: string): string {
  if (toolState.stopReason === "repeated_tool_error") {
    const notes: Record<string, string> = {
      zh: "工具连续失败，已停止重复调用。本轮没有继续执行；请发送“继续”让助手重新读取当前 Set 后再尝试。",
      en: "The same tool failed repeatedly, so repeated calls were stopped. No further changes ran this turn; send “continue” to reread the current Set and try again.",
      de: "Dasselbe Werkzeug ist wiederholt fehlgeschlagen; weitere Aufrufe wurden gestoppt. Sende „weiter“, um den aktuellen Set neu zu lesen.",
      fr: "Le même outil a échoué plusieurs fois ; les appels répétés ont été arrêtés. Envoyez « continuer » pour relire le Set actuel.",
      ja: "同じツールが連続して失敗したため、繰り返し呼び出しを停止しました。「続けて」で現在の Set を読み直して再試行できます。",
      es: "La misma herramienta falló varias veces, así que se detuvieron los reintentos. Envía «continuar» para releer el Set actual.",
      it: "Lo stesso strumento ha fallito più volte; le chiamate ripetute sono state interrotte. Invia «continua» per rileggere il Set attuale.",
    };
    return notes[language ?? ""] ?? notes.en;
  }
  return STOP_NOTE[language ?? ""] ?? STOP_NOTE.en;
}

/** Appended to a reply that stayed truncated after all auto-continuations. */
export const TRUNC_NOTE: Record<string, string> = {
  zh: "（回复超出长度限制被截断，发送「继续」可补全）",
  en: "(Reply hit the token limit and was cut off — send “continue” to finish it.)",
  de: "(Antwort am Token-Limit abgeschnitten — sende „weiter“ zum Fortsetzen.)",
  fr: "(Réponse tronquée par la limite de tokens — envoyez « continuer » pour la terminer.)",
  ja: "（トークン上限で途中で切れました —「続けて」と送信すると続きます）",
  es: "(Respuesta cortada por el límite de tokens — envía «continuar» para completarla.)",
  it: "(Risposta troncata dal limite di token — invia «continua» per completarla.)",
};
