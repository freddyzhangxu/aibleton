# AIbleton User Guide

> 面向音乐制作人的中文使用指南。本文按 AIbleton 的实际界面和能力整理。

AIbleton 是运行在 Ableton Live 里的 AI 音乐制作助手。你可以像和制作搭档聊天一样让它理解当前 Set、提出建议，或直接创建、编辑、编曲、混音和分析内容。

## 1. 开始前

### 所需条件

- Ableton Live **12.4.5 或更高版本**，并支持 Ableton Extensions SDK。
- 已安装 AIbleton `.ablx` 扩展：在 Live 中打开 **设置 → Extensions** 安装。
- 至少一种 AI provider 的可用认证。聊天支持 Codex、Claude Code、Gemini，以及 OpenAI-compatible 服务。
- 如需生成新音频：另准备 Stable Audio、ElevenLabs、MiniMax 或自定义 HTTP 音频服务的 API key。
- 如需使用 808 / 909 等工厂鼓组：安装本机的 **Drum Essentials Pack**；AIbleton 不会自动下载缺失采样。
- 如需使用 AIbletonBar：安装对应 macOS / Windows 的可选侧边栏；未使用侧边栏也可直接在 Live 内使用。

### 首次启动检查

1. 在 Live 中打开 AIbleton。
2. 看窗口顶部状态：若提示未找到认证信息，点击右上角齿轮进入 **AI 配置**。
3. 选择 provider，填入 API Key；必要时填 API 地址和模型名。留空时，Codex / Claude / Gemini 会优先尝试本机 CLI 或环境中的已有配置。
4. 发送一句不改动 Set 的问题，例如：`现在有哪些轨道？` 确认 AI 能返回当前工程概览。

如果你使用 **Custom** provider，必须填写 API 地址和模型；本地服务（例如 Ollama）可按服务要求不填 API Key。AIbleton 使用 OpenAI-compatible chat/completions 协议与 Custom 服务通信。

> **第一次请这样做：** 先把 Set 另存一个版本，关闭 YOLO，发送一个只读问题确认连接正常；第一次实际改动只限定 4 小节。这样即使结果不合意，也容易试听、撤回和比较。

## 2. 认识界面

| 区域 | 用法 |
|---|---|
| 顶栏 | `+` 新建对话；时钟图标打开历史；齿轮打开设置。关闭对话框不会停止已在后台运行的任务。 |
| 输入框 | `Enter` 发送，`Shift+Enter` 换行。描述音乐目标即可，不需要写 tool 名或 JSON。 |
| 模型 / Effort | 点击模型名可直达 AI 配置；Effort 越高，推理通常更充分但会更慢。Custom provider 不显示 Effort，因为没有统一标准。 |
| 附件 | 点击回形针、拖入窗口或粘贴图片 / 文件。详见“附件与参考”。 |
| YOLO | 开启时 AI 可直接执行非付费操作；关闭时每一次会改动 Set 的操作都会出现“允许 / 拒绝”。确认栏只显示摘要，重要改动前仍应要求 AI 明确列出目标轨道、范围和文件。 |
| 发送 / 停止 | 任务进行中，发送箭头变为停止按钮。停止会取消等待中的请求与确认，但已完成的 Live 改动不会自动撤回。 |

## 3. 配置工作方式

### AI provider 与语言

在 **设置 → AI 配置** 中选择：

- **Codex**：默认模型为 `gpt-5-codex`。
- **Claude Code**：默认模型为 `claude-sonnet-5`。
- **Gemini**：默认模型为 `gemini-flash-latest`。
- **Custom**：用于 Grok、DeepSeek、Kimi、OpenRouter、Ollama、vLLM 等兼容端点；自行填写 API 地址与模型。

在 **设置 → 语言** 可切换界面与回复语言。模型、provider、语言和常用设置会保存，重新打开界面后恢复。

### YOLO 与确认

YOLO 默认开启，适合你已经明确知道要做的、可快速撤销的操作。初次使用或进行大范围重排时，建议先关闭它：

1. 关闭输入栏右侧的 **YOLO** 开关。
2. AI 每次准备修改 Live Set 时会显示工具名与关键参数。
3. 确认内容、目标轨道和范围后按 **允许**；按 **拒绝** 则该步不执行。

首次音频生成无论 YOLO 是否开启都会提示确认，因为它消耗外部 API credits。若开启“自动迭代”，你是在预授权同一个目标后续最多 3 次额外付费生成；这些后续生成不会逐次再弹确认。

## 4. 第一次成功：从空轨到可听的 groove

推荐先从一个小而可验证的任务开始：

1. 新建或打开一个 Set。
2. 输入：`建一条叫 Drums 的 MIDI 轨，加载 909 鼓组，写一个 4 小节 124 BPM house groove。`
3. AI 会创建轨道、加载带真实 samples 的 Drum Rack，并写入 MIDI clip。若提示缺少 Drum Essentials 或采样，先安装对应 Pack 后重试。
4. 听一下结果；再输入：`保持 kick 不变，让 hats 更有律动，轻微 swing。`
5. 需要回退时，直接使用 Live 的 Undo（⌘Z / Ctrl+Z）。

这条提示同时给出了角色、目标、长度、速度和风格。相比“做点 house 鼓”，这样的约束能让首次结果更稳定。

## 5. 怎样和 AI 说需求

### 一个好提示包含什么

按需要提供以下信息，没必要每次全写：

- **目标**：新建、分析、修改、编曲、混音或导出准备。
- **对象 / 范围**：轨道名、段落、开始小节、时长。
- **音乐约束**：BPM、调性、风格、参考方向、乐器、能量和复杂度。
- **保护项**：不能改什么，例如“不要动 kick”“保持速度与调性”。
- **验收方式**：例如“Drop 比 Intro 更有能量”“bass 更简洁，保留重拍”。

### 可直接使用的提示

| 目的 | 示例 |
|---|---|
| 了解工程 | `分析当前 Set：调性、段落、各轨角色，以及最值得先处理的两个问题。` |
| 新建 bass | `在 A minor 写一条 4 小节、124 BPM 的 melodic techno bassline；放在第 1 小节，留出 kick 空间。` |
| 改现有素材 | `保持 Bass 轨的音色和长度，把旋律改得更少音、更有呼吸感。` |
| 编曲 | `用现有 clips 排一个 64 小节结构：16 小节 intro、16 小节 build、32 小节 drop；先给我计划和 dry run。` |
| 混音起点 | `检查 Kick、Bass、Pad 的关系；只做保守的音量和声像调整，不添加轨道。` |
| 音色设计 | `给 Synth 加 Auto Filter，做一个从暗到亮的上升感；先查看参数范围，再做少量改动。` |
| 找 sample | `找一个 124 BPM、A minor、dark 的 pad loop，先列出候选，不要导入。` |
| 生成音频 | `生成 8 秒无 vocal、124 BPM、A minor 的 seamless industrial percussion loop，并放到 Texture 音频轨第 33 小节。` |

### 先问、再动手

下面两种说法尤其适合大改动：

```text
先分析当前编曲。只告诉我应该如何让 Drop 更有冲击力，暂时不要改 Set。

为 33–64 小节重排一个 Drop：先给计划和 dry run；确认后再执行。
```

AI 会在需要多步创作、编曲或修复时，先建立可检验的目标并规划步骤。你可以随时要求它停在分析 / 计划阶段，或要求它说明准备修改哪些轨道。

## 6. 常用制作流程

### A. 先分析，再改编曲

1. 说：`分析当前 Set 的段落、track roles、能量对比和重复问题。`
2. 让 AI 根据分析解释问题；不要把分析结果当成审美定论，先听并决定目标。
3. 明确目标：`让 Drop 比 Intro 更有能量，但保持现有 kick 与 tempo 不变。`
4. 多步变更时要求：`先给计划。`
5. 执行后重新听关键转场，再让 AI 做一个小范围 refinement。

AI 的结构分析优先使用 Live cue points；没有 cue points 时，会用 8 小节能量块推断段落。若你希望稳定地按 `Intro / Build / Drop` 工作，建议在 Live 里使用有意义的 cue 名称。

### B. 从现有 clips 重排 Arrangement

让 AI 重排时，不要只说“编一下”。先指定范围和保留策略：

```text
分析所有 Arrangement 和 Session clips，然后用现有素材重排 1–64 小节。
保留源素材；先 dry run，列出每个 placement 的来源、目标小节和冲突。
```

dry run 不会修改 Set。真正执行前要检查：

- 每个 placement 的来源轨道 / clip 是否正确；
- 同一轨道是否发生 clip overlap；
- 是否真的要用 `clear_range_bars` 清除整个范围。

> **清除区间警告：** `clear_range_bars` 会影响**所有轨道**的指定小节（含起止小节），并会裁剪相交 clip。若 source 本身落在清除范围内，AI 可以用已读取的内容创建新 placement，但原 Arrangement source clip 仍会被清除。dry run 只能预览，不能恢复已执行的清除；真正执行后请用 Live Undo 回退。只在明确“重建这一段”时使用。

### C. 鼓、旋律与 MIDI 编辑

- 鼓：让 AI 加载 `808` / `909` / `707` / `606` / `DMX` 鼓组后再写 pattern。返回的 drum pad map 才是可用音高的最终依据。
- 旋律：明确调性、八度、音符密度与段落。例如：`在 A minor、C2–C3 之间写 4 小节 bass，八分音符为主。`
- 修改现有 clip：先让 AI 读取或分析，再明确“替换全部 notes”还是“保留节奏只改音高”。修改 Arrangement MIDI clip 时，写入是整套 notes 的替换，不是自动合并。
- Swing：AI 会把 swing 烘焙进 note timing / velocity；它不会给 clip 分配一个 Live Groove 文件。

### D. 设备与基础混音

先描述听感问题，再限制改动范围：

```text
Pad 太亮、挡住 lead。只在 Pad 轨插入或调整内置设备；先查参数，
再用 EQ Eight 或 Auto Filter 做温和处理，别改音符。
```

AI 可操作 Live 内置设备（例如 Operator、Wavetable、Impulse、Reverb、Auto Filter、Compressor、EQ Eight、Delay），不支持第三方插件。对大型乐器 / 效果器，应先读取并筛选参数，再做少量精确设置。一次需要调整多个参数时，AI 会优先作为一个批量动作执行。

`set_track_mixer` 的音量为 0–1 的归一化数值，约 `0.85 ≈ 0 dB`，不是直接输入 dB。它只改音量 / 声像，不写 automation、send 或 master chain。

### E. 搜索与使用 samples

1. 先说：`找 124 BPM、A minor、warm 的 pad loop。`
2. 让 AI 先显示候选路径；确认风格与文件后再导入。
3. loop / stem 放在 Arrangement：`导入第 2 个候选到 Texture 音频轨，第 33 小节，开启 warp。`
4. bass hit、vocal chop、stab 等可演奏 one-shot：`把第 1 个候选加载到 Vocal Chop 轨的 Simpler。`

本地搜索会查已同步的 Splice、Ableton User Library、Factory Packs 和 Core Library；不会浏览 Splice 在线目录。导入 Arrangement 的目标必须是 **Audio track**；加载到 Simpler 的轨道则用于 MIDI 演奏。

### F. 生成和迭代新音频

在 **设置 → 音频生成** 选择 provider 并填好 key。建议从短、可验证的素材开始：

```text
生成 8 秒 seamless loop：124 BPM、A minor、dry industrial percussion，
不要人声。生成后直接导入 Texture 音频轨第 33 小节。
```

- prompt 目前以**英文**写得最稳定，包含 genre、BPM、key、乐器和 mood。
- loop 使用 `seamless loop`；通常 4–16 秒足够。总时长允许 1–190 秒。
- `instrumental` 可要求无 vocal；lyrics 仅适用于 MiniMax。
- 生成文件保存在 User Library 的 AIbleton 文件夹，并记录 generation id，便于后续按可测指标反复改进。
- “生成后直接导入”是一次调用中的尽力操作：如果导入失败，生成文件仍保留，可让 AI 改用普通导入重试。

“自动迭代”适合有明确可测目标的生成任务，不适合你还在探索风格时盲开。开启它等于预授权同一目标最多额外 3 次付费生成，后续不会逐次确认；先设定时长与预算，再审听每次结果。

## 7. 参考、附件、搜索与记忆

### 附件

支持点击、拖放或粘贴，最多 10 个附件：

- 图片：PNG、JPEG、WebP、GIF；单个不超过 2 MB。
- 文本：txt、md、JSON、CSV、代码、YAML 等；单个不超过 2 MB，传入模型的文本最多取前 20,000 字符。
- MIDI / Live Set：`.mid` / `.midi` / `.als`；单个不超过 5 MB。系统先解析为文字摘要，而不是把二进制工程原样交给模型。

Live 内置 webview 可能不能弹出原生文件选择框；在 Live 中优先用拖放或粘贴。若希望基于参考音频作分析，告诉 AI 本地 WAV / AIFF 的绝对路径以及要比较的段落；参考只用于分析差距和给出保守建议，不应要求复制一首现有作品。

### 联网搜索

在 **设置 → 联网搜索** 开启后，AI 才能搜索近期教程、版本、release notes、新闻等，并可读取静态网页正文。默认关闭。

开启意味着搜索词与抓取的 URL 会发送给对应网站；不会使用账号或 Cookie。不需要实时网页信息时建议保持关闭。本地 sample 文件一律使用 AIbleton 的 sample search，不使用网页搜索。

### 音乐人记忆

在 **设置 → 音乐人记忆** 中填写艺名、风格、BPM 范围、常用调性、音色偏好、参考艺人和备注。也可直接对 AI 说：

```text
记住我主要做 124–128 BPM 的 melodic techno，偏好 909 鼓和温暖的 analog pad。
```

记忆会成为后续对话的默认创作上下文。只保存稳定的长期偏好；例如本次 Set 临时选择 A minor，不应自动变成永久偏好。需要清除或修改时，在设置中直接编辑即可。

## 8. 隐私与本地保存

AIbleton 将你的聊天请求、工具读取到的 Set 信息，以及你发送的图片 / 附件交给所选 AI provider 处理；请只使用你有权分享的工程、采样和参考素材。文本附件会进入本地聊天历史，图片和二进制附件只用于当前请求；`.mid` / `.als` 会先在本机转换为文本摘要再发送。

扩展会在本机保存对话历史、音乐人记忆、provider / 音频生成配置和 Move pairing token，便于下次继续使用。共享电脑时，建议使用权限受限的专用 API key，避免上传未授权素材；离开设备前删除不需要的会话，并在系统或扩展配置中妥善管理凭据。

## 9. Ableton Move

AIbleton 对 Move 有两条独立工作流：**USB-C MIDI 编排** 与 **Wi‑Fi 文件 / Set 管理**。

### USB-C：让 Live 的 clip 在 Move 上发声

前提：Move firmware ≥1.5、Standalone Mode、USB-C 连接。一次性设置：

1. 在 Live 的 **设置 → Link, Tempo & MIDI** 找到 Ableton Move 输出端口，开启 **Track**；需要同步时钟再开启 **Sync**。
2. 说：`建一条通道 1 的 Move 轨。`
3. 按 AI 返回的提示，在 Live 手动把该轨 **Output Type** 设为 `Ableton Move`，**Output Channel** 设为 `1`。
4. 在 Move 按住 `Shift` 并按轨道按钮，将该轨 **MIDI In** 设为同一 channel 或 `Auto`。
5. 现在可以让 AI 往该轨写 Arrangement 或 Session MIDI clip。

这条链路会发送 notes、velocity、poly aftertouch；Move 不接收 MIDI CC，AI 也不能经 SDK 自动设置 Live 的 Output Routing。详细说明见 [Move Guide](../docs/move.zh-CN.md)。

### Wi‑Fi：上传 sample、读取与分析 Move Set

电脑和 Move 必须在同一 Wi‑Fi。首次配对与上传时：

1. 说：`检查我的 Move 是否在线。`
2. 未配对时说：`配对我的 Move。`
3. Move 屏幕显示 6 位 code 后，把它告诉 AI 完成配对。
4. 上传前先说：`列出 Move 的 Samples/Drums 文件夹。`
5. 确认目标目录和同名文件后再说：`把刚生成的文件上传到 Move 的 Samples/Drums 文件夹，不要覆盖同名文件。`
6. 上传后在 Move 上确认文件并试听。

配对 token 会保存；如果再次提示未配对，重新走一次 code 流程即可。上传是对 Move 文件系统的真实写入，**不能通过 Live Undo 撤回**。同名文件默认不覆盖；只有明确要求覆盖时才会替换。Move 没有 Arrangement View，读取到的 clips 会按 Session clips 分析。

## 10. 历史、Skills 与任务控制

- **新建对话**：点击 `+`。适合切换到完全不同的制作目标，避免旧上下文干扰。
- **历史对话**：点击时钟图标可切换、删除会话。删除后无法通过界面恢复，先确认不再需要上下文。
- **Skills**：在空输入框中输入 `/`，选择本地已安装的 skill；选中后会插入 `/skill-name`。Skills 用于把特定工作流或偏好注入当前任务。
- **后台任务**：界面显示“思考中”时可以关闭窗口，任务仍会继续。想中止则在任务运行时点击停止按钮；停止不会回滚已经完成的 Set 写入。

## 11. 安全工作法

1. **先小后大**：先改 4 或 8 小节，满意后再扩展为整段。
2. **有保护项地描述**：`不要改 kick / tempo / key` 比“别改太多”更可靠。
3. **根据操作选保护方式**：Arrangement 重排时关闭 YOLO 并要求 dry run；其他操作没有 dry run，应改用小范围、逐步确认和先备份。样本覆盖、Move 上传与外部服务生成还要确认文件名、目标目录和成本。
4. **每次关键改动都试听**：工具验证“值是否写入”，不能代替你的审美判断。
5. **善用 Live Undo**：`arrange_song` 的整个 placement plan 是一个 Live transaction，通常一次 Undo 即可撤销整个重排。
6. **不盲目重试**：若 AI 说操作执行了但验证没有命中，先让它重新读取实际状态；反复执行可能造成重复 clips 或 notes。
7. **控制生成成本**：先用短时长和明确 prompt；确认满意的方向后再提高时长或开启自动迭代。

## 12. 常见问题

| 现象 | 排查与处理 |
|---|---|
| 顶部显示未找到认证信息 | 齿轮 → AI 配置，选择正确 provider 并填写 key；或确认本机 CLI / 环境变量已登录、重开窗口。Custom 必填 API 地址与模型。 |
| AI 只回答、不改 Set | 检查你的话是否要求执行；若任务在计划 / 分析阶段，明确说“现在执行”。关闭 YOLO 时还需要点“允许”。 |
| AI 等待不动 | 查看是否有确认条；没有时用停止按钮中止并缩小任务范围后重试。 |
| 操作落到错误的轨道 | 先让 AI `get overview` / 分析当前 Set，再用轨道名指代；新增、删除、重排轨道后不要沿用旧索引。 |
| Arrangement 重排被拒绝 | 检查 dry run：来源 clip 是否存在、`clip_index` / `scene_index` 是否只给一个、同一轨道是否 overlap。重新分析后再生成新 plan。 |
| sample 导入失败 | 确认文件实际存在；loop / stem 目标必须是 Audio track。one-shot 需要放到 Simpler 时，改用“加载到 Simpler”。 |
| 找不到本地 sample | AIbleton 只能查已安装 / 已同步的本地库；检查 Splice 是否完成同步、User Library / Pack 是否在本机。 |
| 音频生成报 key 或 provider 错误 | 齿轮 → 音频生成，确认选择的 provider 与 key 对应；Custom 还需检查请求 URL、body template 和响应字段路径。 |
| 生成成功但没有出现在 Arrangement | 文件已保存；让 AI 使用返回文件重新导入，并确认目标是 Audio track。 |
| Move 提示未配对或不可达 | 确认同一 Wi‑Fi、设备已开机；先检查状态，再重新发起配对并输入设备屏幕 code。 |
| macOS 看不到 Ableton Move MIDI 端口 | 拔掉 Move，在“音频 MIDI 设置 → MIDI 工作室”删除旧的 Ableton Move 设备，再重新连接。 |

## 13. 下一步

当你已经习惯基础流程，试试一个完整但仍受控的任务：

```text
分析当前 Set，找出 Drop 与 Intro 的能量差、bass role 和重复问题。
目标是在不改 tempo、key 和 Kick 轨的前提下，让 Drop 更有冲击力。
先给 3 步计划；如果涉及重排 Arrangement，再给 dry run。我确认后再执行，每一步完成后简短汇报。
```

这会充分利用 AIbleton 的优势：先理解音乐上下文，再用可检查、可撤销的动作完成制作任务。
