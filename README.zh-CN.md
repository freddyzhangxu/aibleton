<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  住在 <b>Ableton Live 12</b> 里的 Claude AI 助手 —— 聊天、生成 MIDI、<br>
  装载鼓组、搜索采样、直接控制设备与轨道，全程不用离开 Live。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>中文</b>
</p>

---

## 简介

AIbleton 把 AI 对话助手直接放进 Ableton Live。对它说
*「做一个 140 BPM 的 4 小节 808 鼓型」*、*「给 2 轨加个 Auto Filter，截止频率扫到 800 Hz」*、
*「在我本地采样里找一条 tech house loop 拖进编排」* —— 它会直接在你的 Live Set 里完成。

它同时也是随身的操作指导：问它*「贝斯怎么对底鼓做侧链压缩？」*、
*「这条 loop 的 warp 在哪里设置？」*，它会一步步讲解操作方法 —— 或者直接帮你做完。

项目包含两个部分：

| 组件 | 说明 |
|---|---|
| **[AIbleton/](AIbleton/)** | Live 12 扩展本体：聊天界面 + 本地助手服务，内置约 20 个读写 Live Set 的工具 |
| **[AIbletonBar/](AIbletonBar/)** | 原生 macOS 悬浮侧边栏，把同一个聊天界面挂在 Live 旁边，IDE 式体验，**⌥⌘A** 呼出 |

## 截图

| Live 内置 AI 助手对话框 | AIbletonBar 悬浮侧边栏 |
|:---:|:---:|
| ![Ableton Live 中的 AIbleton 对话框](docs/screenshots/aibleton-dialog.png) | ![停靠在 Ableton Live 旁的 AIbletonBar 侧边栏](docs/screenshots/aibletonbar-sidebar.png) |

## 功能

- **在 Live 里聊天** —— 右键任意轨道 / 场景 / Clip → `打开…`，在模态对话框中与助手对话；
  同一界面也可以在浏览器打开 `http://localhost:17666`，或用 AIbletonBar。
- **MIDI 生成** —— 自然语言生成编排视图或 Session 视图的 MIDI Clip，
  支持逐音符音高 / 时值 / 力度与摇摆（swing）。
- **一键 808 鼓组** —— 自动搭建 Drum Rack，用 Simpler 装载官方 808 采样，
  按 GM 风格音符表直接编程，出声即用。
- **采样搜索与导入** —— 搜索本地 Splice 同步目录、Ableton User Library、
  官方 Packs 与 Core Library，导入音频或装载到 Simpler。
- **设备控制** —— 插入设备（Operator、Auto Filter……），按模糊名称读写参数
  （"freq" → Filter Freq）。
- **轨道与场景操作** —— 创建 / 重命名 / 静音 / 独奏 / 布防轨道，调节音量与声像，
  创建与重命名场景，设置 BPM。
- **操作指导** —— 解答 Live 本身的使用问题（混音、warp、路由、快捷键……），
  在你工作的地方直接给出分步讲解。

## 环境要求

- **Ableton Live 12**（12.4.5+），配套 Extensions SDK beta
- **Node.js ≥ 24.14.1**
- **Claude API 凭证** —— 自动复用 Claude Code 的 `~/.claude/settings.json`，
  或使用 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 环境变量，
  或在对话框「高级」区域手动填写。扩展本身不存储任何敏感信息。
  （目前仅支持 Claude —— Codex 与 Gemini 支持见[路线图](#路线图)。）
- **macOS** —— 仅 AIbletonBar 需要；扩展本体与平台无关
  （Windows 版 AIbletonBar 计划中）

## 安装

```sh
cd AIbleton
npm install

# .env 中的 EXTENSION_HOST_PATH 需指向 Live 的 Extension Host 模块
#（SDK 生成器会自动填写；Live 安装路径变动时请手动修改）

npm start        # 构建并在 Live 的 Extension Host 中运行
```

然后在 Live 里：右键轨道、场景或 Clip → **打开…** —— 或在浏览器打开
`http://localhost:17666`。

### 常用命令

```sh
npm start          # 开发构建 + 在 Live 中运行
npm run build      # 生产构建 src/extension.ts
npm run build:dev  # 开发构建（含 sourcemap，不压缩）
npm run package    # 生产构建 + 打包可分发的 .ablx 文件
```

### AIbletonBar（可选侧边栏）

```sh
cd AIbletonBar
./build.sh            # 编译 AIbletonBar.app（swiftc 直编，无第三方依赖）
open AIbletonBar.app
```

- **⌥⌘A** 全局呼出 / 隐藏；面板吸附屏幕右缘、全高、置顶、随所有 Space 显示。
- Live 未加载扩展时显示离线占位页，连上后自动恢复（3 秒轮询）。

## 工作原理

扩展在 Live 的 Extension Host 内启动一个本地 HTTP 服务（端口 `17666`）。
聊天页面通过一组基于 Extensions SDK 的工具与 Claude 对话 ——
`get_song_overview`、`write_midi_clip`、`write_session_clip`、`load_drum_kit`、
`search_samples`、`import_audio_clip`、`insert_device`、`set_device_parameter`、
`set_track_mixer`、场景与速度工具等。每一句回答都可以直接读写当前打开的 Live Set。

```
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────┐
│ 聊天界面           │      │ 助手服务             │      │ Claude API     │
│（对话框 / 浏览器   │─────▶│ localhost:17666      │─────▶│ （工具调用）   │
│  / AIbletonBar）   │      │ + 约 20 个 Live 工具 │◀─────│                │
└────────────────────┘      └──────────┬───────────┘      └────────────────┘
                                       │ Extensions SDK
                                       ▼
                              ┌──────────────────┐
                              │ Ableton Live 12  │
                              │ （当前 Live Set）│
                              └──────────────────┘
```

## 项目结构

```
AIbleton/          Live 扩展（TypeScript）
├── src/extension.ts   入口 —— 注册右键菜单动作，启动服务
├── src/server.ts      助手服务 + 工具实现
├── ui/interface.html  聊天界面
└── vendor/            Extensions SDK beta 包（已 gitignore，见下方说明）

AIbletonBar/       macOS 悬浮侧边栏（Swift，约 180 行，无依赖）
├── main.swift
├── build.sh           swiftc 编译 + ad-hoc 签名
└── Resources/         应用图标与 Logo
```

## 当前状态

AIbleton 现已开源。Ableton Extensions SDK 仍处于 **beta** 阶段，其安装包不允许
再分发，因此 `vendor/` 目录已被 gitignore —— 自行构建扩展需要先获取 SDK beta
权限（见 https://ableton.github.io/extensions-sdk/）。SDK beta 1 只提供右键菜单
和模态对话框，这正是 AIbletonBar 以独立侧边栏 App 形式存在的原因。

## 路线图

- **更多模型** —— 助手目前基于 Claude，计划支持 OpenAI Codex 与 Google Gemini。
- **Windows 版 AIbletonBar** —— 悬浮侧边栏目前仅支持 macOS，Windows 版本已在计划中。
- **更深度的 Live 集成** —— 待 SDK 正式版提供面板 API 后，把侧边栏直接搬进 Live 内部。

## 免责声明

AIbleton 是独立的开源项目，与 Ableton AG 无任何隶属关系，亦未获得其背书。
"Ableton" 与 "Live" 是 Ableton AG 的商标。

## 许可证

[MIT](LICENSE)
