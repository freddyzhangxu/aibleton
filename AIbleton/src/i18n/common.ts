import { normalizeLanguage, type SupportedLanguage } from "./language.js";

export type CommonMessageKey =
  | "noTextReply"
  | "emptyMessage"
  | "busy"
  | "sessionNotFound"
  | "noRunningTask"
  | "serverStartFailed"
  | "userDenied"
  | "verificationFailed"
  | "doNotRepeat"
  | "toolFailed"
  | "liveObjectGone"
  | "genericError"
  | "requestFailed"
  | "stopped"
  | "budgetExhausted"
  | "planRequiresGoal"
  | "planNoValidSteps"
  | "planDeclaredLate"
  | "goalNoValidCriteria"
  | "goalDeclaredLate"
  | "goalRedeclared"
  | "referenceUnavailable"
  | "invalidGoalWarning"
  | "invalidPlanWarning"
  | "operationCompleted"
  | "genericWarning"
  | "undoInLive"
  | "targetRefreshed"
  | "roundLimitReached"
  | "sampleNoMatch"
  | "contentTruncated"
  | "webDisabled"
  | "deleteNotAuthorized"
  | "moveRoutingSetup"
  | "movePairHint"
  | "movePairCode"
  | "moveUploadComplete"
  | "moveDownloadComplete"
  | "parametersTruncated"
  | "dryRunValidated"
  | "settingsAi"
  | "settingsAudio";

type CommonCopy = Record<CommonMessageKey, string>;

const COPY: Record<SupportedLanguage, CommonCopy> = {
  zh: {
    noTextReply: "（无文本回复）", emptyMessage: "消息不能为空", busy: "上一个任务还在进行中，请稍候",
    sessionNotFound: "会话不存在", noRunningTask: "当前没有运行中的任务", serverStartFailed: "无法启动本地服务",
    userDenied: "用户拒绝了该操作", verificationFailed: "验证失败（操作已执行，未达预期）：{0}",
    doNotRepeat: "请勿直接重复该操作，以免重复创建内容；请按实际状态修正。", toolFailed: "工具操作失败（错误代码：{0}）。请检查目标和参数后重试。",
    liveObjectGone: "操作对象已在 Live 中被删除或失效。请先调用 get_song_overview 读取最新的轨道和 Clip 状态，再重新指定目标。",
    genericError: "发生内部错误（错误代码：{0}）。请重试；如果持续出现，请检查调试日志。", requestFailed: "请求失败", stopped: "已手动停止",
    budgetExhausted: "本回合改动预算已用完（{0} 次修改类调用），该调用未执行。请停止修改，总结已完成和未完成的部分，由用户决定是否继续。",
    planRequiresGoal: "set_plan 需要先声明目标。请先调用 set_goal。", planNoValidSteps: "set_plan 未生效：没有有效步骤。",
    planDeclaredLate: "本回合已有 {0} 次改动先于 set_plan 执行。计划应在修改之前声明。", goalNoValidCriteria: "set_goal 未生效：没有有效的 successCriteria 或 constraints。",
    goalDeclaredLate: "本回合已有 {0} 次改动先于 set_goal 执行；基线捕获的是改动后的状态。", goalRedeclared: "目标已重新声明，之前的计划已清除；请重新调用 set_plan。",
    referenceUnavailable: "参考音频不可用（{0}）；目标校验将不使用参考对比。", invalidGoalWarning: "已忽略一个无效的目标字段。", invalidPlanWarning: "已忽略一个无效的计划字段。",
    operationCompleted: "操作已完成。", genericWarning: "操作返回了一条警告；请检查结构化结果。", undoInLive: "如需撤销，请在 Live 中使用 Undo。", targetRefreshed: "目标索引已根据当前 Live Set 重新定位。",
    roundLimitReached: "已达到工具调用轮次上限（{0} 轮）。本轮操作记录已保存，但任务可能尚未完成。请检查当前 Set；如需继续，请发送“继续”。",
    sampleNoMatch: "没有匹配。请减少关键词或换一种描述；BPM 和调式只影响排序。", contentTruncated: "正文过长，已截断", webDisabled: "联网搜索已关闭。请在设置中打开联网搜索。",
    deleteNotAuthorized: "删除未执行。请在本条消息中明确指定要删除的 {0}；笼统的清理请求不构成删除授权。",
    moveRoutingSetup: "需要一次手动路由：在 Live 中把该轨输出设为 Ableton Move、通道 {0}；Move 使用 1.5 或更高固件、Standalone Mode 和 USB-C，并把对应轨的 MIDI In 设为通道 {0}（或 Auto）。音符、力度和复音触后可传输，MIDI CC 不支持。",
    movePairHint: "设备可达但尚未配对。调用不带 code 的 move_pair，让 Move 显示配对码。", movePairCode: "Move 屏幕上已显示 6 位配对码。请让用户提供该数字，再调用 move_pair({ code }) 完成配对。",
    moveUploadComplete: "{0} 已上传到 Move 的 {1} 文件夹（{2} KB），可装入鼓垫或旋律轨道。", moveDownloadComplete: "Set 已下载到 {0}（{1} KB）。",
    parametersTruncated: "只返回前 {0} 个参数。请使用 filter 按名称查询。", dryRunValidated: "校验通过，未修改 Set；去掉 dry_run 后再次调用即可执行。",
    settingsAi: "设置（齿轮）→ AI 配置", settingsAudio: "设置（齿轮）→ 音频生成",
  },
  en: {
    noTextReply: "(No text response)", emptyMessage: "Message cannot be empty", busy: "The previous task is still running; please wait",
    sessionNotFound: "Conversation not found", noRunningTask: "No task is currently running", serverStartFailed: "Couldn't start the local server",
    userDenied: "The user denied this action", verificationFailed: "Verification failed (the action ran but missed the expected result): {0}",
    doNotRepeat: "Do not repeat the action blindly, because that may duplicate content; correct it from the measured state.", toolFailed: "The tool operation failed (error code: {0}). Check the target and parameters, then retry.",
    liveObjectGone: "The target was deleted or became invalid in Live. Call get_song_overview, then select the target again from the latest state.",
    genericError: "An internal error occurred (error code: {0}). Retry; if it persists, check the debug log.", requestFailed: "Request failed", stopped: "Stopped manually",
    budgetExhausted: "The turn mutation budget is exhausted ({0} mutating calls); this call was not executed. Stop modifying, summarize what landed and what remains, and let the user decide whether to continue.",
    planRequiresGoal: "set_plan requires a declared goal. Call set_goal first.", planNoValidSteps: "set_plan was not applied because it contained no valid steps.",
    planDeclaredLate: "{0} changes ran before set_plan in this turn. Declare the plan before modifying the Set.", goalNoValidCriteria: "set_goal was not applied because it contained no valid successCriteria or constraints.",
    goalDeclaredLate: "{0} changes ran before set_goal in this turn; the baseline therefore reflects the already-modified state.", goalRedeclared: "The goal was re-declared and the previous plan was cleared. Call set_plan again.",
    referenceUnavailable: "The reference audio is unavailable ({0}); goal verification will continue without reference comparison.", invalidGoalWarning: "An invalid goal field was ignored.", invalidPlanWarning: "An invalid plan field was ignored.",
    operationCompleted: "The operation completed.", genericWarning: "The operation returned a warning; inspect the structured result.", undoInLive: "Use Undo in Live if you need to revert this operation.", targetRefreshed: "The target index was refreshed from the current Live Set.",
    roundLimitReached: "The tool-call round limit ({0}) has been reached. This turn's action log was saved, but the task may be incomplete. Review the current Set and send “continue” if needed.",
    sampleNoMatch: "No matches. Use fewer keywords or rephrase the query; BPM and key affect ranking only.", contentTruncated: "Content was truncated because it is too long", webDisabled: "Web Search is off. Enable it in Settings.",
    deleteNotAuthorized: "Deletion was not executed. Explicitly name the {0} to delete in this message; broad cleanup requests are not authorization.",
    moveRoutingSetup: "One-time manual routing is required: in Live, set this track's output to Ableton Move, channel {0}. On Move, use firmware 1.5 or later, Standalone Mode and USB-C, then set the track's MIDI In to channel {0} (or Auto). Notes, velocity and poly aftertouch are supported; MIDI CC is not.",
    movePairHint: "The device is reachable but not paired. Call move_pair without a code so Move displays one.", movePairCode: "Move is showing a six-digit pairing code. Ask the user for it, then call move_pair({ code }).",
    moveUploadComplete: "{0} was uploaded to Move's {1} folder ({2} KB) and can be loaded onto a drum pad or melodic track.", moveDownloadComplete: "The Set was downloaded to {0} ({1} KB).",
    parametersTruncated: "Only the first {0} parameters were returned. Use filter to query by name.", dryRunValidated: "Validation passed and the Set was not changed. Call again without dry_run to execute.",
    settingsAi: "Settings (gear icon) → AI Provider", settingsAudio: "Settings (gear icon) → Audio Generation",
  },
  de: {
    noTextReply: "(Keine Textantwort)", emptyMessage: "Die Nachricht darf nicht leer sein", busy: "Die vorherige Aufgabe läuft noch; bitte warten",
    sessionNotFound: "Unterhaltung nicht gefunden", noRunningTask: "Derzeit läuft keine Aufgabe", serverStartFailed: "Der lokale Server konnte nicht gestartet werden",
    userDenied: "Der Benutzer hat diese Aktion abgelehnt", verificationFailed: "Überprüfung fehlgeschlagen (Aktion ausgeführt, Ziel verfehlt): {0}",
    doNotRepeat: "Die Aktion nicht blind wiederholen; Inhalte könnten dupliziert werden. Anhand des gemessenen Zustands korrigieren.", toolFailed: "Werkzeugoperation fehlgeschlagen (Fehlercode: {0}). Ziel und Parameter prüfen und erneut versuchen.",
    liveObjectGone: "Das Ziel wurde in Live gelöscht oder ist ungültig. Zuerst get_song_overview aufrufen und dann das Ziel neu auswählen.",
    genericError: "Interner Fehler (Fehlercode: {0}). Erneut versuchen; bei Wiederholung das Debug-Protokoll prüfen.", requestFailed: "Anfrage fehlgeschlagen", stopped: "Manuell gestoppt",
    budgetExhausted: "Das Änderungslimit dieser Runde ist erreicht ({0} mutierende Aufrufe); dieser Aufruf wurde nicht ausgeführt. Änderungen zusammenfassen und den Benutzer über die Fortsetzung entscheiden lassen.",
    planRequiresGoal: "set_plan benötigt ein deklariertes Ziel. Zuerst set_goal aufrufen.", planNoValidSteps: "set_plan wurde nicht angewendet, weil keine gültigen Schritte enthalten waren.", planDeclaredLate: "{0} Änderungen wurden vor set_plan ausgeführt. Den Plan vor Änderungen deklarieren.", goalNoValidCriteria: "set_goal wurde nicht angewendet, weil keine gültigen Kriterien vorhanden waren.", goalDeclaredLate: "{0} Änderungen wurden vor set_goal ausgeführt; die Basis enthält bereits diese Änderungen.", goalRedeclared: "Das Ziel wurde neu deklariert und der vorherige Plan gelöscht. set_plan erneut aufrufen.", referenceUnavailable: "Referenzaudio nicht verfügbar ({0}); die Zielprüfung läuft ohne Referenzvergleich weiter.", invalidGoalWarning: "Ein ungültiges Zielfeld wurde ignoriert.", invalidPlanWarning: "Ein ungültiges Planfeld wurde ignoriert.",
    operationCompleted: "Der Vorgang wurde abgeschlossen.", genericWarning: "Der Vorgang gab eine Warnung zurück; das strukturierte Ergebnis prüfen.", undoInLive: "Zum Rückgängigmachen Undo in Live verwenden.", targetRefreshed: "Der Zielindex wurde anhand des aktuellen Live-Sets aktualisiert.",
    roundLimitReached: "Das Limit von {0} Werkzeugrunden ist erreicht. Das Aktionsprotokoll dieses Durchlaufs wurde gespeichert, die Aufgabe ist möglicherweise unvollständig. Prüfe das aktuelle Set und sende bei Bedarf „weiter“.",
    sampleNoMatch: "Keine Treffer. Weniger Suchwörter verwenden oder die Anfrage umformulieren; BPM und Tonart beeinflussen nur die Sortierung.", contentTruncated: "Der Inhalt wurde wegen seiner Länge gekürzt", webDisabled: "Die Websuche ist deaktiviert. In den Einstellungen aktivieren.",
    deleteNotAuthorized: "Löschen wurde nicht ausgeführt. Das zu löschende {0} in dieser Nachricht ausdrücklich nennen; allgemeine Aufräumwünsche sind keine Berechtigung.",
    moveRoutingSetup: "Einmalige manuelle Weiterleitung erforderlich: In Live den Ausgang dieser Spur auf Ableton Move, Kanal {0}, stellen. Auf Move Firmware 1.5 oder neuer, Standalone-Modus und USB-C verwenden und MIDI In der Spur auf Kanal {0} (oder Auto) setzen. Noten, Velocity und polyphoner Aftertouch werden unterstützt; MIDI CC nicht.",
    movePairHint: "Das Gerät ist erreichbar, aber nicht gekoppelt. move_pair ohne Code aufrufen, damit Move einen Code anzeigt.", movePairCode: "Move zeigt einen sechsstelligen Kopplungscode. Den Benutzer danach fragen und dann move_pair({ code }) aufrufen.", moveUploadComplete: "{0} wurde in den Move-Ordner {1} hochgeladen ({2} KB) und kann auf ein Drum-Pad oder eine Melodiespur geladen werden.", moveDownloadComplete: "Das Set wurde nach {0} heruntergeladen ({1} KB).",
    parametersTruncated: "Nur die ersten {0} Parameter wurden zurückgegeben. Mit filter nach Namen suchen.", dryRunValidated: "Validierung bestanden; das Set wurde nicht geändert. Ohne dry_run erneut aufrufen, um auszuführen.",
    settingsAi: "Einstellungen (Zahnrad) → AI-Anbieter", settingsAudio: "Einstellungen (Zahnrad) → Audio-Generierung",
  },
  fr: {
    noTextReply: "(Aucune réponse textuelle)", emptyMessage: "Le message ne peut pas être vide", busy: "La tâche précédente est toujours en cours ; veuillez patienter",
    sessionNotFound: "Conversation introuvable", noRunningTask: "Aucune tâche n'est en cours", serverStartFailed: "Impossible de démarrer le serveur local",
    userDenied: "L'utilisateur a refusé cette action", verificationFailed: "Échec de la vérification (action exécutée, résultat attendu manqué) : {0}",
    doNotRepeat: "Ne répétez pas l'action aveuglément : cela pourrait dupliquer du contenu. Corrigez-la à partir de l'état mesuré.", toolFailed: "Échec de l'outil (code d'erreur : {0}). Vérifiez la cible et les paramètres, puis réessayez.",
    liveObjectGone: "La cible a été supprimée ou invalidée dans Live. Appelez get_song_overview avant de la sélectionner à nouveau.",
    genericError: "Une erreur interne s'est produite (code : {0}). Réessayez ; si elle persiste, consultez le journal de débogage.", requestFailed: "Échec de la requête", stopped: "Arrêté manuellement",
    budgetExhausted: "Le budget de modifications de ce tour est épuisé ({0} appels modificateurs) ; cet appel n'a pas été exécuté. Résumez ce qui a été fait et laissez l'utilisateur décider de continuer.",
    planRequiresGoal: "set_plan nécessite un objectif déclaré. Appelez d'abord set_goal.", planNoValidSteps: "set_plan n'a pas été appliqué car il ne contenait aucune étape valide.", planDeclaredLate: "{0} modifications ont été exécutées avant set_plan. Déclarez le plan avant toute modification.", goalNoValidCriteria: "set_goal n'a pas été appliqué car aucun critère valide n'était présent.", goalDeclaredLate: "{0} modifications ont été exécutées avant set_goal ; la référence inclut donc déjà ces changements.", goalRedeclared: "L'objectif a été redéclaré et le plan précédent supprimé. Appelez set_plan à nouveau.", referenceUnavailable: "L'audio de référence est indisponible ({0}) ; la vérification continue sans comparaison.", invalidGoalWarning: "Un champ d'objectif invalide a été ignoré.", invalidPlanWarning: "Un champ de plan invalide a été ignoré.",
    operationCompleted: "L'opération est terminée.", genericWarning: "L'opération a renvoyé un avertissement ; vérifiez le résultat structuré.", undoInLive: "Utilisez Annuler dans Live pour revenir en arrière.", targetRefreshed: "L'index cible a été actualisé depuis le Live Set courant.",
    roundLimitReached: "La limite de {0} tours d'outils est atteinte. Le journal des actions de ce tour a été enregistré, mais la tâche est peut-être incomplète. Vérifiez le Set actuel et envoyez « continuer » si nécessaire.",
    sampleNoMatch: "Aucun résultat. Utilisez moins de mots-clés ou reformulez ; le BPM et la tonalité influencent seulement le classement.", contentTruncated: "Le contenu a été tronqué car il est trop long", webDisabled: "La recherche web est désactivée. Activez-la dans les paramètres.",
    deleteNotAuthorized: "La suppression n'a pas été exécutée. Nommez explicitement le {0} à supprimer dans ce message ; une demande générale de nettoyage n'est pas une autorisation.",
    moveRoutingSetup: "Un routage manuel unique est requis : dans Live, réglez la sortie de cette piste sur Ableton Move, canal {0}. Sur Move, utilisez le firmware 1.5 ou ultérieur, le mode autonome et l'USB-C, puis réglez MIDI In sur le canal {0} (ou Auto). Notes, vélocité et aftertouch polyphonique sont pris en charge, pas les CC MIDI.",
    movePairHint: "L'appareil est accessible mais non associé. Appelez move_pair sans code pour que Move en affiche un.", movePairCode: "Move affiche un code d'association à six chiffres. Demandez-le à l'utilisateur puis appelez move_pair({ code }).", moveUploadComplete: "{0} a été envoyé dans le dossier {1} de Move ({2} Ko) et peut être chargé sur un pad ou une piste mélodique.", moveDownloadComplete: "Le Set a été téléchargé vers {0} ({1} Ko).",
    parametersTruncated: "Seuls les {0} premiers paramètres ont été renvoyés. Utilisez filter pour rechercher par nom.", dryRunValidated: "Validation réussie sans modifier le Set. Rappelez la commande sans dry_run pour l'exécuter.",
    settingsAi: "Paramètres (icône engrenage) → Fournisseur IA", settingsAudio: "Paramètres (icône engrenage) → Génération audio",
  },
  ja: {
    noTextReply: "（テキスト応答なし）", emptyMessage: "メッセージを空にできません", busy: "前のタスクが実行中です。しばらくお待ちください",
    sessionNotFound: "会話が見つかりません", noRunningTask: "現在実行中のタスクはありません", serverStartFailed: "ローカルサーバーを起動できませんでした",
    userDenied: "ユーザーがこの操作を拒否しました", verificationFailed: "検証失敗（操作は実行されましたが期待結果に未達成）：{0}",
    doNotRepeat: "内容が重複する可能性があるため、同じ操作をそのまま繰り返さず、実測状態に基づいて修正してください。", toolFailed: "ツール操作に失敗しました（エラーコード：{0}）。対象とパラメータを確認して再試行してください。",
    liveObjectGone: "対象が Live で削除または無効化されました。get_song_overview を呼び出してから対象を選び直してください。",
    genericError: "内部エラーが発生しました（エラーコード：{0}）。再試行し、続く場合はデバッグログを確認してください。", requestFailed: "リクエスト失敗", stopped: "手動で停止しました",
    budgetExhausted: "このターンの変更予算を使い切りました（変更呼び出し {0} 回）。この呼び出しは実行されていません。完了済みと未完了を要約し、続行するかユーザーに確認してください。",
    planRequiresGoal: "set_plan には宣言済みの目標が必要です。先に set_goal を呼び出してください。", planNoValidSteps: "有効なステップがないため set_plan は適用されませんでした。", planDeclaredLate: "このターンでは set_plan より前に {0} 回の変更が実行されました。変更前に計画を宣言してください。", goalNoValidCriteria: "有効な成功条件または制約がないため set_goal は適用されませんでした。", goalDeclaredLate: "set_goal より前に {0} 回の変更が実行されたため、基準には変更後の状態が含まれます。", goalRedeclared: "目標が再宣言され、前の計画は消去されました。set_plan を再実行してください。", referenceUnavailable: "参照オーディオを利用できません（{0}）。参照比較なしで目標検証を続けます。", invalidGoalWarning: "無効な目標フィールドを無視しました。", invalidPlanWarning: "無効な計画フィールドを無視しました。",
    operationCompleted: "操作が完了しました。", genericWarning: "操作から警告が返されました。構造化結果を確認してください。", undoInLive: "元に戻す場合は Live の Undo を使用してください。", targetRefreshed: "現在の Live Set に基づいて対象インデックスを更新しました。",
    roundLimitReached: "ツール呼び出し回数の上限（{0} 回）に達しました。このターンの操作履歴は保存されましたが、タスクは未完了の可能性があります。現在の Set を確認し、必要なら「続けて」と送信してください。",
    sampleNoMatch: "一致する項目がありません。キーワードを減らすか言い換えてください。BPM とキーは並び順だけに影響します。", contentTruncated: "本文が長すぎるため切り詰めました", webDisabled: "Web 検索は無効です。設定で有効にしてください。",
    deleteNotAuthorized: "削除は実行されませんでした。このメッセージで削除する {0} を明示してください。一般的な整理依頼は削除許可になりません。",
    moveRoutingSetup: "初回のみ手動ルーティングが必要です。Live でこのトラックの出力を Ableton Move、チャンネル {0} に設定します。Move はファームウェア 1.5 以降、Standalone Mode、USB-C を使用し、対象トラックの MIDI In をチャンネル {0}（または Auto）に設定してください。ノート、ベロシティ、ポリ・アフタータッチに対応し、MIDI CC には対応しません。",
    movePairHint: "デバイスには接続できますが未ペアリングです。code なしで move_pair を呼び出し、Move にコードを表示させてください。", movePairCode: "Move に6桁のペアリングコードが表示されています。ユーザーにコードを確認し、move_pair({ code }) を呼び出してください。", moveUploadComplete: "{0} を Move の {1} フォルダーへアップロードしました（{2} KB）。ドラムパッドまたはメロディートラックに読み込めます。", moveDownloadComplete: "Set を {0} にダウンロードしました（{1} KB）。",
    parametersTruncated: "先頭の {0} 個のパラメータだけを返しました。filter で名前を指定してください。", dryRunValidated: "検証に成功し、Set は変更されていません。実行するには dry_run なしで再度呼び出してください。",
    settingsAi: "設定（歯車）→ AI プロバイダー", settingsAudio: "設定（歯車）→ 音声生成",
  },
  es: {
    noTextReply: "(Sin respuesta de texto)", emptyMessage: "El mensaje no puede estar vacío", busy: "La tarea anterior sigue en curso; espera un momento",
    sessionNotFound: "No se encontró la conversación", noRunningTask: "No hay ninguna tarea en ejecución", serverStartFailed: "No se pudo iniciar el servidor local",
    userDenied: "El usuario rechazó esta acción", verificationFailed: "La verificación falló (la acción se ejecutó, pero no logró el resultado esperado): {0}",
    doNotRepeat: "No repitas la acción a ciegas, porque podría duplicar contenido; corrígela a partir del estado medido.", toolFailed: "La operación de la herramienta falló (código de error: {0}). Comprueba el objetivo y los parámetros y vuelve a intentarlo.",
    liveObjectGone: "El objetivo se eliminó o dejó de ser válido en Live. Llama a get_song_overview y vuelve a seleccionarlo desde el estado actual.",
    genericError: "Se produjo un error interno (código: {0}). Reinténtalo; si persiste, revisa el registro de depuración.", requestFailed: "La solicitud falló", stopped: "Detenido manualmente",
    budgetExhausted: "Se agotó el presupuesto de cambios de este turno ({0} llamadas con cambios); esta llamada no se ejecutó. Resume lo completado y lo pendiente y deja que el usuario decida si continúa.",
    planRequiresGoal: "set_plan necesita un objetivo declarado. Llama primero a set_goal.", planNoValidSteps: "set_plan no se aplicó porque no contenía pasos válidos.", planDeclaredLate: "Se ejecutaron {0} cambios antes de set_plan en este turno. Declara el plan antes de modificar el Set.", goalNoValidCriteria: "set_goal no se aplicó porque no contenía successCriteria ni constraints válidos.", goalDeclaredLate: "Se ejecutaron {0} cambios antes de set_goal; la línea base ya refleja esos cambios.", goalRedeclared: "El objetivo se volvió a declarar y se borró el plan anterior. Vuelve a llamar a set_plan.", referenceUnavailable: "El audio de referencia no está disponible ({0}); la verificación continuará sin comparación.", invalidGoalWarning: "Se ignoró un campo de objetivo no válido.", invalidPlanWarning: "Se ignoró un campo de plan no válido.",
    operationCompleted: "La operación se completó.", genericWarning: "La operación devolvió una advertencia; revisa el resultado estructurado.", undoInLive: "Usa Deshacer en Live si necesitas revertir la operación.", targetRefreshed: "El índice del objetivo se actualizó desde el Live Set actual.",
    roundLimitReached: "Se alcanzó el límite de {0} rondas de herramientas. Se guardó el registro de acciones de este turno, pero la tarea podría estar incompleta. Revisa el Set actual y envía «continuar» si hace falta.",
    sampleNoMatch: "No hay coincidencias. Usa menos palabras clave o reformula la búsqueda; el BPM y la tonalidad solo afectan al orden.", contentTruncated: "El contenido se truncó porque es demasiado largo", webDisabled: "La búsqueda web está desactivada. Actívala en Ajustes.",
    deleteNotAuthorized: "No se ejecutó la eliminación. Indica explícitamente el {0} que quieres eliminar en este mensaje; una petición general de limpieza no es autorización.",
    moveRoutingSetup: "Se necesita un enrutamiento manual inicial: en Live, configura la salida de esta pista como Ableton Move, canal {0}. En Move, usa firmware 1.5 o posterior, modo autónomo y USB-C, y configura MIDI In de la pista en el canal {0} (o Auto). Se admiten notas, velocidad y aftertouch polifónico; MIDI CC no.",
    movePairHint: "El dispositivo está accesible pero no emparejado. Llama a move_pair sin código para que Move muestre uno.", movePairCode: "Move muestra un código de emparejamiento de seis dígitos. Pídeselo al usuario y llama a move_pair({ code }).", moveUploadComplete: "{0} se subió a la carpeta {1} de Move ({2} KB) y puede cargarse en un pad o una pista melódica.", moveDownloadComplete: "El Set se descargó en {0} ({1} KB).",
    parametersTruncated: "Solo se devolvieron los primeros {0} parámetros. Usa filter para buscar por nombre.", dryRunValidated: "La validación pasó y el Set no se modificó. Vuelve a llamar sin dry_run para ejecutar.",
    settingsAi: "Ajustes (icono de engranaje) → Proveedor de IA", settingsAudio: "Ajustes (icono de engranaje) → Generación de audio",
  },
  it: {
    noTextReply: "(Nessuna risposta testuale)", emptyMessage: "Il messaggio non può essere vuoto", busy: "L'attività precedente è ancora in corso; attendi",
    sessionNotFound: "Conversazione non trovata", noRunningTask: "Nessuna attività è in esecuzione", serverStartFailed: "Impossibile avviare il server locale",
    userDenied: "L'utente ha rifiutato questa azione", verificationFailed: "Verifica non riuscita (azione eseguita, risultato previsto non raggiunto): {0}",
    doNotRepeat: "Non ripetere l'azione alla cieca: potrebbe duplicare contenuti. Correggila in base allo stato misurato.", toolFailed: "Operazione dello strumento non riuscita (codice errore: {0}). Controlla destinazione e parametri, poi riprova.",
    liveObjectGone: "La destinazione è stata eliminata o invalidata in Live. Chiama get_song_overview e selezionala di nuovo dallo stato attuale.",
    genericError: "Si è verificato un errore interno (codice: {0}). Riprova; se persiste, controlla il registro di debug.", requestFailed: "Richiesta non riuscita", stopped: "Interrotto manualmente",
    budgetExhausted: "Il budget di modifiche del turno è esaurito ({0} chiamate con modifiche); questa chiamata non è stata eseguita. Riassumi quanto completato e ciò che resta e lascia decidere all'utente se continuare.",
    planRequiresGoal: "set_plan richiede un obiettivo dichiarato. Chiama prima set_goal.", planNoValidSteps: "set_plan non è stato applicato perché non conteneva passaggi validi.", planDeclaredLate: "In questo turno sono state eseguite {0} modifiche prima di set_plan. Dichiara il piano prima delle modifiche.", goalNoValidCriteria: "set_goal non è stato applicato perché non conteneva criteri validi.", goalDeclaredLate: "Sono state eseguite {0} modifiche prima di set_goal; la base include già tali modifiche.", goalRedeclared: "L'obiettivo è stato dichiarato di nuovo e il piano precedente è stato cancellato. Richiama set_plan.", referenceUnavailable: "L'audio di riferimento non è disponibile ({0}); la verifica continuerà senza confronto.", invalidGoalWarning: "È stato ignorato un campo obiettivo non valido.", invalidPlanWarning: "È stato ignorato un campo piano non valido.",
    operationCompleted: "L'operazione è stata completata.", genericWarning: "L'operazione ha restituito un avviso; controlla il risultato strutturato.", undoInLive: "Usa Annulla in Live per ripristinare l'operazione.", targetRefreshed: "L'indice di destinazione è stato aggiornato dal Live Set corrente.",
    roundLimitReached: "È stato raggiunto il limite di {0} cicli degli strumenti. Il registro delle azioni di questo turno è stato salvato, ma l'attività potrebbe essere incompleta. Controlla il Set attuale e invia «continua» se necessario.",
    sampleNoMatch: "Nessun risultato. Usa meno parole chiave o riformula la ricerca; BPM e tonalità influiscono solo sull'ordine.", contentTruncated: "Il contenuto è stato troncato perché troppo lungo", webDisabled: "La ricerca web è disattivata. Abilitala nelle Impostazioni.",
    deleteNotAuthorized: "L'eliminazione non è stata eseguita. Indica esplicitamente il {0} da eliminare in questo messaggio; una richiesta generica di pulizia non è un'autorizzazione.",
    moveRoutingSetup: "È necessario un instradamento manuale iniziale: in Live imposta l'uscita della traccia su Ableton Move, canale {0}. Su Move usa firmware 1.5 o successivo, modalità Standalone e USB-C, quindi imposta MIDI In della traccia sul canale {0} (o Auto). Sono supportati note, velocity e aftertouch polifonico; MIDI CC non lo è.",
    movePairHint: "Il dispositivo è raggiungibile ma non associato. Chiama move_pair senza codice affinché Move ne mostri uno.", movePairCode: "Move mostra un codice di associazione a sei cifre. Chiedilo all'utente e poi chiama move_pair({ code }).", moveUploadComplete: "{0} è stato caricato nella cartella {1} di Move ({2} KB) e può essere assegnato a un pad o a una traccia melodica.", moveDownloadComplete: "Il Set è stato scaricato in {0} ({1} KB).",
    parametersTruncated: "Sono stati restituiti solo i primi {0} parametri. Usa filter per cercare per nome.", dryRunValidated: "La convalida è riuscita e il Set non è stato modificato. Richiama senza dry_run per eseguire.",
    settingsAi: "Impostazioni (icona ingranaggio) → Provider AI", settingsAudio: "Impostazioni (icona ingranaggio) → Generazione audio",
  },
};

function fill(template: string, args: readonly unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
}

export function commonText(language: string | undefined, key: CommonMessageKey, ...args: readonly unknown[]): string {
  return fill(COPY[normalizeLanguage(language)][key], args);
}
