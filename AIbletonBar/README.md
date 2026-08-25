# AIbletonBar

**English** · [中文](#中文)

A floating macOS sidebar for AIbleton — a small native window that loads the chat
service served by the Live extension (`http://localhost:17666`), giving you an
IDE-style side chat panel next to Ableton Live.

> ⚠️ **Not a standalone app.** AIbletonBar is only a window shell — the AI chat
> and all Live control run inside the **AIbleton extension**. Install
> **`AIbleton-x.y.z.ablx`** first (Live → **Settings → Extensions**, drop the file
> onto the page — get it from
> [Releases](https://github.com/freddyzhangxu/aibleton/releases)). Without the
> extension loaded, the sidebar only shows an offline placeholder.

> Ableton Extensions SDK beta 1 only supports right-click menus / modal dialogs —
> there is no panel API. So the sidebar experience is implemented as a separate
> floating window. The extension itself needs no changes.

---

## Download & Open (⚠️ macOS will block it)

The app is **ad-hoc signed** and not notarized by Apple, so Gatekeeper blocks the
first launch of anything downloaded from the internet. This is normal — here's how
to open it:

1. Download and unzip `AIbletonBar-*-macOS.zip`
2. Drag **AIbletonBar.app** into **Applications** (or anywhere you like)
3. Open it with **one** of the two methods below:

### Method 1 — Terminal (recommended, always works)

```sh
xattr -cr /Applications/AIbletonBar.app
```

> If you left it in Downloads instead:
> ```sh
> xattr -cr ~/Downloads/AIbletonBar.app
> ```

Then double-click the app — it opens normally from now on.

### Method 2 — GUI

Right-click (Control-click) the app → **Open** → click **Open** in the dialog.

If macOS says the app *"is damaged and can't be opened"* (common on Apple
silicon), it's a false alarm caused by the quarantine flag — use **Method 1**
instead; the app is not actually damaged.

**Why this happens:** files downloaded from the internet carry a `com.apple.quarantine`
attribute, and an ad-hoc signature is not from an Apple-identified developer, so
Gatekeeper refuses to launch it. `xattr -cr` only removes that quarantine flag —
it does not modify the app itself. Apps you build yourself with `build.sh` have no
quarantine flag and open directly.

## Usage

- **⌥⌘A** — global hotkey to show / hide
- Docks to the right edge of the screen, full height, always on top, visible on all Spaces
- 🔴 close = hide; 🟡 minimize = collapses into a small bar docked at the bottom-right corner (click anywhere on the bar, or 🟡 again, to restore)
- The close button only hides the window — quit from the **menu-bar icon**
- Shows an offline placeholder when the Live extension isn't loaded; reconnects automatically (3 s polling)
- Requires the **AIbleton extension** loaded in Live (chat server on port 17666)

## Build from source

Requires Xcode Command Line Tools (Swift toolchain):

```sh
./build.sh           # builds AIbletonBar.app + AIbletonBar-<version>-macOS.zip
open AIbletonBar.app # launch
```

## Files

| File | Purpose |
|---|---|
| `main.swift` | All logic (~180 lines, no third-party dependencies) |
| `Info.plist` | `LSUIElement` — menu-bar utility, no Dock icon |
| `build.sh` | `swiftc` compile + bundle + ad-hoc sign + zip; version synced from `AIbleton/package.json` |

## Customize

- Hotkey: edit the key code / modifiers in `RegisterEventHotKey` in `main.swift`
- Width: `PANEL_WIDTH` (default 420)
- Launch at login: System Settings → General → Login Items → add `AIbletonBar.app`

---
---

# 中文

AIbleton 的悬浮侧边栏 —— 原生 macOS 小窗，加载 Live 扩展里的聊天服务
（`http://localhost:17666`），体验等同 IDE 侧边对话栏。

> ⚠️ **不能独立使用。** AIbletonBar 只是一个窗口外壳 —— AI 对话和 Live 控制
> 都运行在 **AIbleton 扩展**里。请先在 Live 中安装 **`AIbleton-x.y.z.ablx`**
> （设置 → Extensions 页面，把文件拖进去 —— 到
> [Releases](https://github.com/freddyzhangxu/aibleton/releases) 下载）。
> 没装扩展时，侧边栏只会显示离线占位页。

> Ableton Extensions SDK beta 1 只支持右键菜单 / 模态对话框，没有面板 API，
> 所以用独立悬浮窗实现侧边栏体验。扩展本体无需任何改动。

---

## 下载后如何打开（⚠️ macOS 一定会拦截）

应用是 **ad-hoc 签名**，没有经过苹果公证，所以从网上下载的 app 首次打开一定会被
Gatekeeper 拦截。这是正常现象，按下面步骤操作即可：

1. 下载并解压 `AIbletonBar-*-macOS.zip`
2. 把 **AIbletonBar.app** 拖进「应用程序」（或任意位置）
3. 用以下**任意一种**方法打开：

### 方法一 —— 终端命令（推荐，100% 有效）

```sh
xattr -cr /Applications/AIbletonBar.app
```

> 如果 app 还留在「下载」文件夹里：
> ```sh
> xattr -cr ~/Downloads/AIbletonBar.app
> ```

之后双击即可正常打开，以后也不会再被拦。

### 方法二 —— 图形界面

右键（或 Control+点击）app → **打开** → 弹窗里再点 **打开**。

如果提示 app「**已损坏，无法打开，应移到废纸篓**」（Apple 芯片常见），这是隔离标记
造成的误报 —— 请改用**方法一**，app 并没有真的损坏。

**原理**：从网上下载的文件会带上 `com.apple.quarantine` 隔离属性，而 ad-hoc 签名
不是苹果认证的开发者，所以 Gatekeeper 拒绝运行。`xattr -cr` 只是去掉这个隔离标记，
**不会修改 app 本身**。自己用 `build.sh` 编译的 app 没有隔离属性，可直接打开。

## 使用

- **⌥⌘A** 全局呼出 / 隐藏
- 窗口默认吸附屏幕右缘、全高、置顶、随所有 Space 显示
- 🔴 关闭 = 隐藏；🟡 最小化 = 收成小条停靠屏幕右下角（点小条任意处或再点 🟡 恢复）
- 关闭按钮只隐藏、不退出；**菜单栏图标**可退出程序
- Live 里没加载扩展时显示离线占位页，连上后自动恢复（3 秒轮询）
- 需要 Live 中已加载 **AIbleton 扩展**（聊天服务在 17666 端口）

## 从源码编译

需要 Xcode Command Line Tools（Swift 工具链）：

```sh
./build.sh           # 编译出 AIbletonBar.app + AIbletonBar-<版本>-macOS.zip
open AIbletonBar.app # 启动
```

## 文件

| 文件 | 作用 |
|---|---|
| `main.swift` | 全部逻辑（~180 行，无第三方依赖） |
| `Info.plist` | `LSUIElement` = 菜单栏工具，不占 Dock |
| `build.sh` | swiftc 直编 + 打包 + 签名 + zip；版本号自动同步 `AIbleton/package.json` |

## 自定义

- 改快捷键：`main.swift` 里 `RegisterEventHotKey` 的按键码 / 修饰键
- 改宽度：`PANEL_WIDTH`（默认 420）
- 开机自启：系统设置 → 通用 → 登录项 → 添加 `AIbletonBar.app`
