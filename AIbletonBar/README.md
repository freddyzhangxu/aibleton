# AIbletonBar

AIbleton 的悬浮侧边栏 —— 原生 macOS 小窗，加载 Live 扩展里的聊天服务
（`http://localhost:17666`），体验等同 IDE 侧边对话栏。

> Ableton Extensions SDK beta 1 只支持右键菜单 / 模态对话框，没有面板 API，
> 所以用独立悬浮窗实现侧边栏体验。扩展本体无需任何改动。

## 用法

```sh
./build.sh           # 编译出 AIbletonBar.app
open AIbletonBar.app # 启动
```

- **⌥⌘A** 全局呼出 / 隐藏
- 窗口默认吸附屏幕右缘、全高、置顶、随所有 Space 显示
- 🔴 关闭 = 隐藏；🟡 最小化 = 收成小条停靠屏幕右下角（点条上任意处或再点🟡恢复）；🟢 已隐藏
- 关闭按钮 = 隐藏，不退出；菜单栏图标可退出
- Live 里没加载扩展时显示离线占位页，连上后自动恢复（3 秒轮询）

## 文件

| 文件 | 作用 |
|---|---|
| `main.swift` | 全部逻辑（~180 行，无第三方依赖） |
| `Info.plist` | `LSUIElement` = 菜单栏工具，不占 Dock |
| `build.sh` | swiftc 直编 + 打包 + ad-hoc 签名 |

## 自定义

- 改快捷键：`main.swift` 里 `RegisterEventHotKey` 的按键码 / 修饰键
- 改宽度：`PANEL_WIDTH`（默认 420）
- 开机自启：系统设置 → 通用 → 登录项 → 添加 `AIbletonBar.app`
