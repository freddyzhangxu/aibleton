# 合并试听建议与任务执行回执设计

## 目标

将成功操作后的试听建议从独立卡片合并到折叠的任务执行回执中，减少每个任务在聊天中的系统 UI 数量。

## 行为

- 不再在工具调用摘要后渲染独立 `.hints` 卡片。
- 每个成功修改 Live Set 的任务仍只显示一个默认收起的回执。
- 展开回执时显示：实际改动、试听建议、Live Undo 提示。
- `unmet` 回执额外显示服务器测得的校验差距；`passed` 和 `completed` 不显示目标或校验明细。
- 纯读取、失败或拒绝操作既没有独立试听卡，也没有回执。

## 实现

- 保留 `receipt.listenHints` 的服务端持久化字段，不改变历史 API 或 builder。
- 删除 `addSteps()` 对 `addListenHints()` 的调用，并移除只服务于独立卡片的 UI 代码与 CSS。
- 回执展开渲染继续通过 `hintLines(receipt.listenHints)` 本地化试听文案。
- 仅当 `receipt.status === "unmet"` 时渲染 `receipt.verification`。

## 验收

- 有回执的消息没有独立 `.hints` 元素。
- 默认收起的回执保持单行；展开后出现试听与 Undo。
- 已达标回执不出现“目标”或“系统校验”行。
- 未达标回执出现“系统校验”行。
- Playwright 交互测试、全套单元测试与生产构建通过。
