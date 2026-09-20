# 单句试听建议设计

## 目标

将一个任务回执中的多条、重复的试听提示合并成一句本地化指令，降低展开回执的阅读负担。

## 行为

- 同一轨道的 Scene、Arrangement 小节、Solo 与 A/B 建议合并为一条句子。
- 示例：`试听：触发 Scene 或从第 1–4 小节播放 909 Drums（建议 Solo）。`
- 多轨道时，按回执 hint 的首次出现顺序为每个轨道生成一句；不重复同一轨道或同一建议。
- 没有可用试听 hint 时不显示“试听”行。
- 提示继续跟随界面语言本地化。

## 实现

- 用一个纯前端 `compactListenSummary()` 取代对 `hintLines()` 的直接回执渲染。
- 按 `tracks` 聚合 hint，合并 Scene、最小 Arrangement 范围、Solo 与 A/B 标志。
- 每个聚合结果生成一句；未知或畸形 hint 忽略，不影响回执其余内容。
- 回执数据、服务端 builder 与历史 API 保持不变。

## 验收

- 一个 Scene hint 与一个 Arrangement hint 命中同一轨道时，UI 只显示一句试听建议。
- 该句包含 Scene、范围和 Solo 信息，轨道名仅出现一次。
- 多轨道仍按首次出现顺序显示，每轨一行。
- Playwright 覆盖中文本地化、去重与无 hint 的情况；全套测试与生产构建通过。
