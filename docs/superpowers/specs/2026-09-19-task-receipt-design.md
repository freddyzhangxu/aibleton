# 任务执行回执设计

## 目标

让用户在每个实际修改 Live Set 的 AI 回合结束时，一眼知道：改了什么、系统是否验证了目标、该试听哪里，以及不满意时如何通过 Live Undo 撤回。

回执是 AI 回复的结构化附属信息，而不是新的任务页面、自动撤销系统或模型生成的摘要。

## 范围

### 首版包含

- 仅当本回合至少有一次成功的 Set 修改时生成回执。
- 在对话中，按“工具步骤 → AI 回复 → 回执卡”的顺序显示。
- 回执随 `HistoryMessage` 持久化，重开面板和切换历史对话后仍可见。
- 有 `set_goal` 的任务显示服务端最终测得的“达标”或“未达标”。
- 没有目标的单次/简单修改显示“已执行”，不推断音乐质量。
- 显示目标（如有）、实际成功工具、去重试听提示与 Live Undo 提示。

### 明确不包含

- 自动触发 Live Undo、Redo 或保存 Live Set。
- 新的任务中心、筛选页、独立历史面板或回执操作按钮。
- 解析模型自然语言来判断事实或质量。
- 在纯聊天、分析、搜索、计划声明、被拒绝或失败的调用后显示回执。
- 展示完整工具参数、原始 JSON 或逐项内部校验对象。

## 数据模型

在 `src/chat/session.ts` 定义可选字段，保持现有历史完全兼容：

```ts
interface TurnReceipt {
  status: "completed" | "passed" | "unmet";
  objective?: string;
  tools: string[];
  listenHints: ListenHint[];
  verification?: string;
  undo: "live_undo";
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ToolAction[];
  receipt?: TurnReceipt;
}
```

`tools` 只保留本回合真正成功执行、且不在 `READ_ONLY_TOOLS` 内的工具名，按第一次成功执行的顺序去重。`listenHints` 来自该成功调用已有的 `listen_hint`，以语义相同的 hint 去重。

`verification` 是服务器基于目标校验生成的短文本，不使用模型回复。目标未声明、校验没有运行或无法测得时省略该字段。旧 `HistoryMessage` 缺少 `receipt` 时保持原样，无需迁移。

## 服务端设计

### 统一数据来源

所有 Provider 都已通过相同的 `finishChat(context, actions, reply)` 完成回合。回执生成放在这条公共收口路径，避免 Claude、Codex、Gemini 与 Custom Provider 出现行为差异。

`agent/runtime.ts` 在目标门禁最终退出时，把服务器测得的任务结论以一个可选、只读的本回合结果暴露给收口层：

- `passed`：目标校验通过；附带短的校验摘要。
- `unmet`：最终停止且目标未通过；附带未达成标准的短摘要。
- 无结果：未声明目标、任务在目标校验前中止或校验发生内部错误。

该结果必须在 `resetTurnState()` 开始新用户回合时清除。运行时状态只用于当前回合，持久化的事实只写入 `HistoryMessage.receipt`。

### 回执构建规则

创建一个独立、纯函数的 receipt builder，输入为本回合 actions 与可选目标结论，输出 `TurnReceipt | undefined`：

1. 筛选非只读工具。
2. 排除 `result` 含 `error` 的调用；这些调用没有成功修改 Set，不能计入回执。
3. 若筛选为空，返回 `undefined`。
4. 提取、排序并去重工具名与 `listen_hint`。
5. 有最终通过结论时返回 `passed`；有最终未达标结论时返回 `unmet`；其余返回 `completed`。
6. 若目标结论含 objective，保留它；若含测得摘要，保留短摘要。
7. 始终将 `undo` 设为 `live_undo`，由 UI 用当前语言渲染正确键位提示。

Builder 不访问 SDK、不读取磁盘、不调用 Live；任何未知或畸形工具结果都当作没有可提取的数据，绝不抛出。

## UI 设计

`ui/interface.html` 在现有 `addSteps()` 与 `addMsg()` 后调用 `addReceipt(message.receipt)`。

卡片为窄侧栏适配的单列信息块：

1. 状态标题：`任务回执 · 已达标`、`任务回执 · 未达标` 或 `任务回执 · 已执行`。
2. 可选目标行。
3. “实际改动”行，显示成功工具的本地化名称与数量。
4. 可选“系统校验”行，显示服务器短摘要。
5. 可选“试听”行，复用 listen hint 的本地化描述。
6. 固定尾注：不满意可在 Live 使用 Undo（macOS `⌘Z`，Windows `Ctrl+Z`）。

状态色只用于辅助扫读：`passed` 绿色、`unmet` 琥珀色、`completed` 中性。所有关键状态仍以文本表达。回执内容使用 `textContent` 和已有 DOM API 创建，不插入任何模型或历史数据到 `innerHTML`。

## 错误处理与兼容性

- 回执生成包在 `finishChat` 的非关键路径中；失败时仍保存并返回原有聊天回复和 actions。
- 现有 `/api/history` 原样返回可选字段；旧客户端忽略它，新客户端在字段缺失时跳过卡片。
- 用户点击 Stop 后，已成功写入 Set 的 actions 仍按同一规则产生“已执行”回执；它不会声称目标达标。
- 目标校验内部错误不会伪造成“未达标”；回执退回“已执行”。

## 测试与验收

### 单元测试

- 纯读取、`set_goal`、`set_plan` 或仅被拒绝/报错的工具调用不生成回执。
- 一个或多个成功写操作生成回执，工具按首见顺序去重。
- `listen_hint` 被保留并去重；缺失/畸形 hint 不抛错。
- 目标通过映射为 `passed`；最终未达标映射为 `unmet`；无校验结论映射为 `completed`。
- `resetTurnState()` 不让上回合的目标结果污染下回合。
- `finishChat` 将 receipt 持久化，旧消息与没有 receipt 的消息仍可读取。

### UI 验收

- 新完成的有修改任务显示一张卡，顺序在工具步骤和 AI 回复之后。
- 重开窗口/切换会话后，卡片完全重现。
- 只读任务无卡；失败或拒绝调用不显示为改动。
- 窄侧栏中卡片无横向滚动，长工具名和验证文本会换行。
- 中文与英文至少覆盖状态、字段标题和 Undo 提示；其他已有 UI 语言缺少专用文本时可回退英文，但不得显示内部 key。

## 实施边界

预计触及：`src/chat/session.ts`、一个 receipt builder 模块、`src/agent/runtime.ts`、相关单元测试和 `ui/interface.html`。不修改 Provider 循环、工具权限、Live SDK 调用、YOLO、确认条或既有历史 API 路径。
