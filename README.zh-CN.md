<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  <b>运行在 Ableton Live 中的 AI 音乐制作 Agent。</b><br>
  直接在 Live 中创作、理解、分析、编曲、编辑和优化音乐。
</p>

<p align="center">
  <b>Chat · Create · Analyze · Reason · Arrange · Edit · Control</b>
</p>

<p align="center">
  支持 <b>Codex、Claude、Gemini 及其他兼容的 AI 模型</b>，直接融入你的音乐制作流程。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>中文</b>
</p>

<p align="center">
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/v/release/freddyzhangxu/aibleton?include_prereleases&label=version" alt="Version"></a>
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/downloads/freddyzhangxu/aibleton/total" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

---

## 下载

**当前版本：v0.9.10**

前往 [**Releases**](https://github.com/freddyzhangxu/aibleton/releases) 下载最新版本。

| 文件 | 说明 |
|---|---|
| `AIbleton-0.9.10.ablx` | Live 扩展，**必需**。通过 **Live → 设置 → 扩展** 安装。 |
| `AIbletonBar-0.9.10-macOS.zip` | 可选的 macOS 浮动侧边栏。 |
| `AIbletonBar-0.9.10-Windows.zip` | 可选的 Windows 浮动侧边栏。 |

## 什么是 AIbleton？

大多数 AI 音乐工具可以生成音乐，或者给你提供建议。

**AIbleton 是一个运行在 Ableton Live 中的 AI 音乐制作 Agent，可以直接创作、理解、分析、编曲、编辑和优化音乐。**

你可以让它从零开始创作，也可以让它改进已有作品、分析编曲，或者直接修改当前的 Live Set。

例如：

> “在 A 小调创建一个 4 小节的 Bassline。”

> “让 Bass 简洁一些，不要这么密集。”

> “分析一下这个编曲，告诉我现在还缺什么。”

> “给这个 Synth 加一个 Auto Filter，并做一个 Cutoff Sweep。”

> “创建一个受经典 909 Groove 启发的鼓组。”

AIbleton 可以读取你的 Live Set，理解音乐上下文，对音乐进行推理，并直接在 Live 中执行操作。

## 截图

| Live 中的 AI Agent 对话框 | AIbletonBar 浮动侧边栏 |
|:---:|:---:|
| ![AIbleton Live 中的 AI Agent 对话框](docs/screenshots/aibleton-dialog.png) | ![AIbletonBar 侧边栏](docs/screenshots/aibletonbar-sidebar.png) |

| AI 搜索 Samples 并通过 Wi-Fi 发送到 Move | Samples 已传输到设备 |
|:---:|:---:|
| ![AIbleton 向 Ableton Move 上传 Samples](docs/screenshots/move-upload-samples.png) | ![Ableton Move 中的 Samples](docs/screenshots/move-samples-webui.png) |

## 核心能力

### Create — 创作

- 生成 MIDI Clip 和音乐片段
- 创建鼓组 Groove 和乐器声部
- 使用支持的 AI Provider 生成音频
- 加载 Drum Kit 和乐器
- 将自然语言创意直接转化为音乐内容

### Understand — 理解

- 分析当前 Live Set
- 检查 Track、Clip、MIDI、Device 和参数
- 理解调性、速度、Track 角色和音乐上下文
- 分析编曲结构和音乐段落
- 分析音频特征

### Reason — 推理

- 从 Live Set 中提取结构化音乐特征
- 理解 Track 与 Section 之间的关系
- 分析不同段落之间的对比与相似性
- 理解音乐角色和编曲发展
- 给出基于音乐证据的分析
- 使用 Reference Track 进行音乐比较

### Arrange — 编曲

- 创建和修改编曲
- 处理不同音乐段落
- 生成和编辑 Clip
- 根据 Section 上下文进行修改
- 在执行前规划音乐制作任务

### Edit & Control — 编辑与控制

- 创建和管理 Track、Scene
- 插入和控制 Device
- 修改 Mixer 和 Device 参数
- 批量执行 Sound Design 修改
- 直接控制 Ableton Live

### Refine — 优化

AIbleton 可以利用音频分析形成迭代式音乐制作闭环：

```text
生成
 ↓
导入
 ↓
分析
 ↓
评估
 ↓
优化
 ↓
再次分析
```

生成的音乐可以根据可量化的音乐目标进行评估，并通过多轮迭代不断优化。

### Search & Remember — 搜索与记忆

- 搜索本地 Sample Library
- 在启用后搜索 Web
- 记住 Artist 偏好和音乐上下文
- 重用 Reference 和分析结果

### Ableton Move

- 分析 Move Set
- 传输 Samples
- 处理 Move MIDI 和 Project
- 将 Live Samples 上传到 Move
- 将 Move 融入 AI 音乐制作流程

## 工作方式

```text
用户意图
    ↓
AI Agent
    ↓
理解 Live Set
    ↓
Music Intelligence
    ├─ 音乐特征
    ├─ 音乐关系
    ├─ 音乐分析
    └─ 音乐推理
    ↓
规划
    ↓
Creative Actions
    ↓
Ableton Live
    ↓
分析与验证
    ↓
必要时继续优化
```

AIbleton 将 **AI 模型** 与 **音乐制作运行时** 分离，因此可以使用不同的 AI Provider，同时保持一致的 Live 集成和音乐制作工具。

## Music Intelligence — 音乐智能

AIbleton 建立在对 Live Set 音乐状态的结构化理解之上。

```text
Live Set
   ↓
Music State
   ↓
Musical Features
   ↓
Relationships
   ↓
Reasoning
   ↓
Creative Actions
   ↓
Agent
   ↓
Live
```

这意味着 AIbleton 不只是执行单个指令。

它可以在执行操作前后理解和分析：

- 音乐上下文
- 音乐结构
- Track 与 Section 之间的关系
- 用户意图
- 可量化的音乐结果

从而让 Agent 不只是“执行命令”，而是能够**理解音乐、制定计划、执行操作并验证结果**。

## Agent Runtime

AIbleton 使用 Agent Runtime 协调：

- 自然语言意图
- 任务规划与执行
- Tool Calls
- Goal Tracking
- 执行结果验证
- Retry 与 Replanning
- 音乐分析
- Audio Feedback
- 与 AI Provider 无关的模型访问

目标不是简单地生成一个回答，而是：

**完成一个音乐制作任务，并在 Ableton Live 中验证结果。**

## 安装

### 系统要求

- Ableton Live 12.4.5+
- 支持 Ableton Extensions SDK
- 一个 AI Provider

从 [Releases](https://github.com/freddyzhangxu/aibleton/releases) 下载最新的 `.ablx` 文件，然后在：

**Ableton Live → 设置 → 扩展**

中安装。

AIbleton 同时提供可选的 **AIbletonBar** 浮动界面，支持 macOS 和 Windows。

## 开发

```bash
git clone https://github.com/freddyzhangxu/aibleton.git
cd aibleton/AIbleton
npm install
npm start
```

开发和 SDK 配置请参阅项目相关文档。

## Roadmap

### 1.0 — AI 音乐制作

AIbleton 1.0 的目标，是让 AI 音乐制作在 Ableton Live 中变得**可靠、实用并真正可用于生产环境**。

1.0 的核心范围包括：

- 可靠的 Live Set 理解
- 音乐推理与任务规划
- MIDI 和音频创作
- 编曲与 Section 编辑
- Sound Design 与 Device 控制
- 基于 Reference 的音乐分析
- Audio Feedback 与迭代优化
- 可靠的 Agent 执行与结果验证
- 稳定的 Provider-agnostic AI 工作流
- Production-ready 的 UX 与可靠性

### Beyond 1.0 — 未来方向

未来版本可能进一步扩展：

- 更深入的实时交互
- AI 辅助 Live Performance
- 面向现场演出的智能控制
- 更高级的实时音乐决策
- 更深入的硬件与现场演出工作流集成

## 项目状态

AIbleton 是一个基于 Ableton Extensions SDK 构建的开源 **AI 音乐制作 Agent**。

项目正在迈向 1.0，目前重点关注：

- 稳定性
- Agent Quality
- Music Intelligence
- Audio Feedback 与迭代优化
- Provider 稳定性
- 产品体验与整体打磨

Ableton Extensions SDK 仍在持续演进，相关 API 和能力可能发生变化。

> AIbleton 与 Ableton AG 无隶属、合作或官方背书关系。  
> “Ableton” 和 “Live” 是 Ableton AG 的商标。

## License

[MIT](LICENSE)
