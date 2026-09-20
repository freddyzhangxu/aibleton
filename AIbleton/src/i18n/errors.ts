import { normalizeLanguage, type SupportedLanguage } from "./language.js";

export type ApiErrorKind = "networkProxy" | "network" | "quota" | "rate" | "auth" | "model" | "overloaded" | "generic";

const COPY: Record<SupportedLanguage, Record<ApiErrorKind, string>> = {
  zh: {
    networkProxy: "连不上 {0}：代理连接失败（{1}）— 确认代理已启动且端口正确，或检查网络后重试。",
    network: "连不上 {0} — 检查网络连接（海外服务可能需要代理）后重试。",
    quota: "{0} 账户额度不足 — 到 {0} 控制台充值/升级，或在 {1} 更换 API Key。",
    rate: "请求太频繁，{0} 暂时限流。等 1 分钟再试；持续出现请到 {0} 控制台检查账户用量额度。",
    auth: "{0} 拒绝了请求：API Key 无效或已过期。打开 {1} 重新填写后再试。",
    model: "{0} 不认识模型{1}。打开 {2} 检查模型名拼写。",
    overloaded: "{0} 服务暂时繁忙{1} — 稍后重试即可，不用改设置。",
    generic: "{0} 出错{1}：{2} — 若反复出现，请检查 {3} 的配置。",
  },
  en: {
    networkProxy: "Couldn't reach {0}: proxy connection failed ({1}) — check that the proxy is running on the right port, then try again.",
    network: "Couldn't reach {0} — check your network connection (an overseas service may need a proxy) and try again.",
    quota: "Your {0} account is out of quota — top up in the {0} console, or set a different API key in {1}.",
    rate: "{0} is rate-limiting requests. Wait a minute and retry; if it persists, check your {0} account usage.",
    auth: "{0} rejected the request: the API key is invalid or expired. Open {1} to update it, then try again.",
    model: "{0} doesn't recognize the model{1}. Open {2} and check the model name.",
    overloaded: "{0} is temporarily overloaded{1} — try again in a moment; no settings change is needed.",
    generic: "{0} failed{1}: {2} — if this keeps happening, check {3}.",
  },
  de: {
    networkProxy: "{0} ist nicht erreichbar: Proxy-Verbindung fehlgeschlagen ({1}) — Proxy und Port prüfen und erneut versuchen.",
    network: "{0} ist nicht erreichbar — Netzwerkverbindung prüfen und erneut versuchen.",
    quota: "Das {0}-Konto hat kein Kontingent mehr — im {0}-Konto aufladen oder einen anderen API-Schlüssel unter {1} verwenden.",
    rate: "{0} begrenzt die Anfragen. Eine Minute warten und erneut versuchen; bei Wiederholung die Kontonutzung prüfen.",
    auth: "{0} hat die Anfrage abgelehnt: Der API-Schlüssel ist ungültig oder abgelaufen. Unter {1} aktualisieren.",
    model: "{0} kennt das Modell{1} nicht. Modellnamen unter {2} prüfen.",
    overloaded: "{0} ist vorübergehend überlastet{1} — später erneut versuchen; keine Einstellungsänderung nötig.",
    generic: "{0} ist fehlgeschlagen{1}: {2} — bei Wiederholung {3} prüfen.",
  },
  fr: {
    networkProxy: "Impossible de joindre {0} : échec de la connexion au proxy ({1}) — vérifiez le proxy et son port, puis réessayez.",
    network: "Impossible de joindre {0} — vérifiez la connexion réseau puis réessayez.",
    quota: "Le compte {0} n'a plus de quota — rechargez-le ou utilisez une autre clé API dans {1}.",
    rate: "{0} limite temporairement les requêtes. Attendez une minute puis réessayez ; si cela persiste, vérifiez l'utilisation du compte.",
    auth: "{0} a refusé la requête : la clé API est invalide ou expirée. Mettez-la à jour dans {1}.",
    model: "{0} ne reconnaît pas le modèle{1}. Vérifiez son nom dans {2}.",
    overloaded: "{0} est temporairement surchargé{1} — réessayez plus tard, sans modifier les paramètres.",
    generic: "Échec de {0}{1} : {2} — si le problème persiste, vérifiez {3}.",
  },
  ja: {
    networkProxy: "{0} に接続できません：プロキシ接続に失敗しました（{1}）。プロキシとポートを確認して再試行してください。",
    network: "{0} に接続できません。ネットワーク接続を確認して再試行してください。",
    quota: "{0} アカウントの利用枠がありません。{0} で追加するか、{1} で別の API キーを設定してください。",
    rate: "{0} がリクエストを制限しています。1分待って再試行し、続く場合はアカウント使用量を確認してください。",
    auth: "{0} がリクエストを拒否しました。API キーが無効または期限切れです。{1} で更新してください。",
    model: "{0} はモデル{1}を認識しません。{2} でモデル名を確認してください。",
    overloaded: "{0} は一時的に混雑しています{1}。設定を変更せず、少し待って再試行してください。",
    generic: "{0} でエラーが発生しました{1}：{2}。続く場合は {3} を確認してください。",
  },
  es: {
    networkProxy: "No se pudo conectar con {0}: falló la conexión al proxy ({1}). Comprueba el proxy y el puerto y vuelve a intentarlo.",
    network: "No se pudo conectar con {0}. Comprueba la conexión de red y vuelve a intentarlo.",
    quota: "La cuenta de {0} no tiene cuota. Recárgala en {0} o usa otra clave API en {1}.",
    rate: "{0} está limitando las solicitudes. Espera un minuto y vuelve a intentarlo; si continúa, revisa el uso de la cuenta.",
    auth: "{0} rechazó la solicitud: la clave API no es válida o ha caducado. Actualízala en {1}.",
    model: "{0} no reconoce el modelo{1}. Comprueba el nombre en {2}.",
    overloaded: "{0} está temporalmente saturado{1}. Vuelve a intentarlo en unos instantes; no hace falta cambiar la configuración.",
    generic: "{0} falló{1}: {2}. Si continúa ocurriendo, revisa {3}.",
  },
  it: {
    networkProxy: "Impossibile raggiungere {0}: connessione al proxy non riuscita ({1}). Controlla proxy e porta e riprova.",
    network: "Impossibile raggiungere {0}. Controlla la connessione di rete e riprova.",
    quota: "L'account {0} ha esaurito la quota. Ricaricalo oppure usa un'altra chiave API in {1}.",
    rate: "{0} sta limitando le richieste. Attendi un minuto e riprova; se continua, controlla l'utilizzo dell'account.",
    auth: "{0} ha rifiutato la richiesta: la chiave API non è valida o è scaduta. Aggiornala in {1}.",
    model: "{0} non riconosce il modello{1}. Controlla il nome in {2}.",
    overloaded: "{0} è temporaneamente sovraccarico{1}. Riprova tra poco; non occorre modificare le impostazioni.",
    generic: "{0} non è riuscito{1}: {2}. Se il problema persiste, controlla {3}.",
  },
};

function fill(template: string, args: readonly unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
}

export function apiErrorText(language: string | undefined, kind: ApiErrorKind, ...args: readonly unknown[]): string {
  return fill(COPY[normalizeLanguage(language)][kind], args);
}

