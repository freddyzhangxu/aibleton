<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  <b>Ableton Live 里的 AI 音乐制作智能体。</b><br>
  AIbleton 理解你的 Live Set，对你的音乐进行推理，把自然语言的想法变成 Ableton Live 里的真实改动。
</p>

<p align="center">
  聊天 · 创作 · 分析 · 推理 · 编曲 · 编辑 · 控制
</p>

<p align="center">
  在你的 Live 工作流中直接使用 <b>Codex、Claude、Gemini 或其他兼容 AI 模型</b>。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>中文</b>
</p>

<p align="center">
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/v/release/freddyzhangxu/aibleton?include_prereleases&label=%E7%89%88%E6%9C%AC" alt="版本"></a>
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/downloads/freddyzhangxu/aibleton/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F" alt="下载量"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

---

## 下载

**当前版本：v0.9.7**（预发布）—— 前往
[**Releases 页面**](https://github.com/freddyzhangxu/aibleton/releases) 下载：

| 文件 | 说明 |
|---|---|
| [AIbleton-0.9.7.ablx](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.7/AIbleton-0.9.7.ablx) | Live 扩展本体 —— **必装**。拖进 Live 的 **设置 → Extensions** 页面即可。 |
| [AIbletonBar-0.9.7-macOS.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.7/AIbletonBar-0.9.7-macOS.zip) | 可选的 macOS 悬浮侧边栏。 |
| [AIbletonBar-0.9.7-Windows.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.7/AIbletonBar-0.9.7-Windows.zip) | 可选的 Windows 悬浮侧边栏。 |

用户无需安装 Node.js —— 扩展运行在 Live 自带的 Extension Host 中。

## 什么是 AIbleton？

大多数 AI 音乐工具只能生成音乐或给你建议。

**AIbleton 能真正处理你在 Ableton Live 里已经打开的音乐。**

你可以这样问：

> 「这个工程现在是什么状态？」

> 「写一条 A 小调的 4 小节 bassline。」

> 「让 bass 别那么满。」

> 「分析一下编排，告诉我还缺什么。」

> 「给合成器加一个 Auto Filter，扫动截止频率。」

智能体可以**检查你的 Live Set、理解音乐上下文、进行推理，并直接在 Live 中执行改动。**

## 截图

| Live 内置 AI 智能体对话框 | AIbletonBar 悬浮侧边栏 |
|:---:|:---:|
| ![Ableton Live 中的 AIbleton 对话框](docs/screenshots/aibleton-dialog.png) | ![停靠在 Ableton Live 旁的 AIbletonBar 侧边栏](docs/screenshots/aibletonbar-sidebar.png) |

| AI 找采样并经 Wi-Fi 推送到 Move | ……随即出现在设备上 |
|:---:|:---:|
| ![AIbleton 向 Ableton Move 上传雷鬼鼓采样](docs/screenshots/move-upload-samples.png) | ![move.local 中看到的 Move 上 Reggae Drum 采样文件夹](docs/screenshots/move-samples-webui.png) |

## 核心能力

### 理解

- 分析当前 Live Set
- 查看轨道、Clip、MIDI 与设备
- 检测调性、轨道角色与音乐统计
- 分析编排结构
- 分析音频特征

### 推理

- 从 Live Set 提取结构化音乐特征
- 分析轨道与段落之间的关系
- 比较段落间的对比度与相似度
- 理解编排走向与音乐角色
- 产出有证据支撑的音乐观察
- 使用参考曲目进行音乐对比

### 创作与编曲

- 生成 MIDI 与鼓型
- 创建与编辑 Clip
- 用支持的 provider 生成音频
- 构建与修改编排
- 用自然语言指令创建段落
- 规划并验证针对特定段落的改动

### 编辑与控制

- 创建与管理轨道、场景
- 插入与控制设备
- 调整混音与设备参数
- 让 AI 智能体直接控制 Ableton Live

### 搜索与记忆

- 搜索本地采样库
- 联网搜索
- 维护音乐人记忆（Artist Memory）与风格偏好

### Ableton Move

- 分析 Move Set
- 传输采样
- 处理 Move MIDI 与工程
- 把 Move 接入 AI 辅助工作流

## 工作原理

```text
用户意图
    ↓
AI 智能体
    ↓
理解 Live Set
    ↓
音乐智能（Music Intelligence）
    ├─ 音乐特征
    ├─ 关系
    ├─ 推理
    └─ 规划
    ↓
创作操作
    ↓
Ableton Live
    ↓
更新后的工程
```

AIbleton 把 **AI 模型**与 **Live 集成层**分离 —— 你可以自由更换模型，用同一套工具处理你的音乐。

## 音乐智能（Music Intelligence）

AIbleton 围绕对 Live Set 音乐状态的结构化理解而构建。

```text
Live Set
   ↓
音乐状态
   ↓
音乐特征
   ↓
关系
   ↓
推理
   ↓
创作操作
   ↓
智能体
   ↓
Live
```

这让 AIbleton 超越简单的指令执行，成为一个能**理解音乐结构、关系、上下文与意图 —— 并据此规划和执行改动**的智能体。

## 安装

### 环境要求

- Ableton Live 12.4.5+
- Ableton Extensions SDK 支持
- 一个 AI 服务商

从上方 [下载](#下载) 区获取最新的 `.ablx`，然后安装到：

**Ableton Live → 设置 → Extensions**

AIbleton 还提供可选的 **AIbletonBar** 悬浮界面（macOS / Windows）。

## 开发

```bash
git clone https://github.com/freddyzhangxu/aibleton.git
cd aibleton/AIbleton
npm install
npm start
```

开发与 SDK 配置详见仓库文档。

## 路线图

AIbleton 正在走向更深层的智能体音乐制作工作流：

- **State Diff & Snapshots** —— 理解并追踪工程变化
- **更深的音乐理解** —— 更丰富的关系、角色与编排意图
- **音频反馈闭环** —— 创作 → 分析 → 评估 → 改进
- **更深的 Ableton 集成** —— 跟进 Extensions SDK 的能力演进

## 当前状态

AIbleton 是一个基于 Ableton Extensions SDK 构建的**开源实验项目**。

SDK 仍在演进，API 与能力可能发生变化。

> AIbleton 与 Ableton AG 无任何隶属关系，亦未获得其背书。
> "Ableton" 与 "Live" 是 Ableton AG 的商标。

## 许可证

[MIT](LICENSE)
