# Audio 轨目标的 MIDI 自动创建设计

## 背景

当用户要求在指定轨道生成 MIDI，而目标轨道实际是 Audio Track 时，AIbleton 当前会在 `write_midi_clip` 或 `write_session_clip` 中直接报错。用户需要手动新建 MIDI 轨，再重新发起请求，打断了生成流程。

## 目标

- 对 MIDI 写入请求统一支持 Audio Track 目标的自动兜底。
- 自动创建一条空 MIDI 轨，并将本次 MIDI Clip 写入新轨。
- 原 Audio Track 及其已有内容保持不变。
- 返回新 MIDI 轨的名称和实际位置，让模型可以准确确认结果。
- 保留现有 MIDI Track 写入行为和现有轨道引用校验。

## 非目标

- 不修改或搬移原 Audio Track。
- 不复制 Audio Track 的 Clip、设备、混音设置或自动化。
- 不承诺新轨位于目标 Audio Track 前面。
- 不实现新的 Ableton SDK 轨道排序/移动能力。
- 不扩展到 take-lane MIDI 写入；本次仅覆盖 Arrangement 和 Session 两条普通 MIDI 写入路径。

## SDK 约束

当前锁定的 Ableton Extensions SDK 仅提供 `song.createMidiTrack()`，其位置由 Live 当前选中轨道决定；没有按索引插入或移动轨道的 API。因此新轨由 Live 按当前 SDK 规则创建，工具结果必须报告实际轨道位置，不能向用户声称完成了“前插”。

## 方案

### 1. Dispatcher 层自动解析目标

在 `write_midi_clip` 和 `write_session_clip` 的 dispatcher 分支中：

1. 先通过现有 `resolveTrack` 解析 `track_index + track_name`。
2. 如果目标是 `MidiTrack`，沿用现有逻辑。
3. 如果目标是 `AudioTrack`，在同一个变更事务中创建 MIDI Track，并将后续写入目标切换到新轨。
4. 为新轨生成稳定且可读的名称：`MIDI - <原轨道名>`；若名称已存在，追加递增后缀以避免歧义。
5. 预先完成长度、音符、swing 和 snap 等输入校验，再创建新轨，减少产生孤立空轨的概率。

建议抽取一个内部 helper，负责“从目标轨道解析 MIDI 写入目标”，返回：

- 实际可写入的 `MidiTrack`；
- 实际轨道索引；
- 实际轨道名称；
- 是否自动创建；
- 原目标轨道名称和索引（用于结果说明）。

### 2. 工具结果

正常 MIDI 目标的返回结构保持兼容。Audio 目标自动创建时，在现有结果中使用新 MIDI 轨作为 `track_index`，并增加类似字段：

```ts
{
  track_index: 3,
  track: "MIDI - Vocal",
  auto_created_midi_track: true,
  source_audio_track: "Vocal",
  source_audio_track_index: 2,
  track_position_note: "新轨位置由 Live SDK 当前创建规则决定"
}
```

这样现有写入后的验证逻辑仍可以按结果里的实际 MIDI 轨索引检查 Clip，同时模型可以在回复中说明原 Audio 轨未被修改。

### 3. Prompt 规则

在系统提示中补充：当用户要求向 Audio Track 写 MIDI 时，不要重复调用写入工具等待报错；写入工具会自动创建 MIDI Track 并继续生成。回复必须使用新轨的实际名称和 one-based 轨道序号，并说明新轨位置由 Live 当前规则决定（如果结果包含位置提示）。

工具 schema 对两个 MIDI 写入工具的描述也要反映这一行为，避免模型继续把 Audio Track 类型错误当作不可恢复错误。

## 错误处理

- `length_beats`、音符格式、scene 序号等输入校验在创建轨道前完成。
- 若创建 MIDI 轨失败，直接返回创建失败，不对原 Audio 轨执行写入。
- 若新轨创建成功但 Clip 写入失败，返回“新 MIDI 轨已创建但 Clip 写入失败”的明确错误，并带上新轨名称/位置，避免模型盲目重试导致重复建轨。
- 继续使用 `track_name` 配合索引解析，防止轨道变化后写错目标。
- selection guard 仍以用户原始目标轨道校验；自动创建的新轨是同一工具调用内部产生的结果，不要求用户事先选中新轨。

## 验证

新增或更新以下测试：

1. `write_midi_clip` 目标为 MIDI Track：行为与现有测试一致。
2. `write_midi_clip` 目标为 Audio Track：创建一条 MIDI Track，Clip 写入新轨，Audio Track 内容不变。
3. `write_session_clip` 目标为 Audio Track：同样自动创建并写入新轨的 Session 槽。
4. 自动生成名称存在冲突时，名称追加后缀且仍能通过 `track_name` 精确引用。
5. 自动创建后的结果包含实际 `track_index`、新轨名称和原 Audio 轨信息。
6. Prompt 测试覆盖 Audio Track 自动创建规则。
7. 运行完整 TypeScript 测试和 `npm run build`。

## 验收标准

- 用户对 Audio Track 发起 MIDI 生成请求时，不再收到“不是 MIDI 轨道”的失败。
- MIDI 内容落在自动创建的 MIDI Track 上。
- 原 Audio Track 的名称、Clip 和设备保持不变。
- 结果明确区分原 Audio Track 与新 MIDI Track，并报告实际位置。
- 现有 MIDI Track、Arrangement、Session 写入路径无回归。
