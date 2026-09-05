# 用 AIbleton 驱动 Ableton Move

AIbleton 可以把写好的 clip 通过 USB-C 发送到 **Ableton Move** 上播放——Live 充当
MIDI 中枢，Move 充当外部音源，用它自带的乐器（Drift、Drum Sampler 等）发声。

> English version: [move.md](move.md)

## 前提条件

| 一侧 | 要求 |
|---|---|
| Move | 固件 **≥ 1.5**，**Standalone 模式**（不是 Control Live 模式），**USB-C** 连接 |
| Live | 12.x，AIbleton ≥ 0.9.3 |
| macOS | 如果 MIDI 端口里看不到 "Ableton Move"，看下面的 *macOS 坑* |

固件 1.5 新增了 "Exchange MIDI with USB Hosts"，DAW 才能经 USB-C 向 Move 的轨道
发 MIDI。在 Move 上 **Setup → About** 查版本，需要时用 Move Manager 升级。

## 一次性设置

1. USB-C 连接 Move，在 Standalone 模式下开机。
2. Live → **设置 → Link, Tempo & MIDI** → 找到 **Ableton Move** 输出端口，打开
   **Track**（想让 Live 发 MIDI 时钟就再开 **Sync**）。
3. 在对话里说"建一条通道 1 的 Move 轨"——AIbleton 会调用 `create_move_track`
   创建名为 `Move Ch 1` 的 MIDI 轨。
4. **手动一步（每个 Set 一次）：** Extensions SDK 无法设置输出路由，请自己把该轨
   的 **Output Type → Ableton Move**、**Output Channel → 1**。之后 Live 会随 Set
   记住这个设置。
5. 在 Move 上选接收轨道：按住 **Shift + 按轨道按钮** → 把 **MIDI In** 设为同一通道
   （或 **Auto**——接收所有未被其他轨道显式占用的通道）。

完成——直接说"往 Move 轨写一段 4 小节 house 鼓"，Move 就会用它自己的音色播放。

## 能与不能

| 可以 | 不行 |
|---|---|
| 音符、力度、复音触后 | **MIDI CC**（Move 直接忽略——旋钮自动化走不过去） |
| 4 条轨道 = 4 个 MIDI 通道 | 把 Move 的状态读回 Live |
| MIDI 时钟同步（端口上开 **Sync**） | AIbleton 实时流式演奏（clip 由 Live 引擎播放） |
| WiFi 下的 Ableton Link（替代时钟方案） | 远程操控 Move 的界面/Session |

音高说明：

- Move 鼓垫布局与 Drum Rack 一致，从 **36（C1）** 开始往上排。
- 旋律轨道按正常音高响应；每条轨道的 MIDI In 通道在硬件上设（Shift + 轨道按钮）。

## macOS 坑

如果这台 Move 曾在固件 **≤ 1.4.1** 时连过这台 Mac，macOS 会残留旧的 MIDI 设备
条目，导致新的端口配置刷不出来：

1. 拔掉 Move。
2. 打开 **音频 MIDI 设置 → MIDI 工作室**，删除 **Ableton Move** 设备。
3. 重新连接 Move。

## 典型流程

```
你:  给我建一条 Move 轨，通道 1
AI:  [create_move_track] → 轨道已建好；请把 Output Type 设为 Ableton Move、
     Output Channel 设为 1（每个 Set 只需一次）
你:  写一段 4 小节 house 鼓
AI:  [write_session_clip] → 已写入，触发 clip 即可在 Move 上听到
```

## WiFi 文件传输（配对）

AIbleton 也能直接调用 Move Manager 的原生 HTTP API——不用插线、不用 SSH：

| 工具 | 作用 |
|---|---|
| `move_status` | 设备可达性、配对状态、固件版本 |
| `move_pair` | 配对握手（Move 屏幕显示 6 位码） |
| `move_list_sets` | 列出设备上的 Set |
| `move_list_files` | 浏览文件夹/文件（Samples、Recordings……） |
| `move_upload_sample` | 把本地音频推上 Move（默认 `Samples` 文件夹） |
| `move_download_set` | 把 Set（`.ablbundle`）拉回 User Library 的 AIbleton 文件夹 |

配对只需一次——令牌由扩展持久保存：

```
你:  配对我的 Move
AI:  [move_pair] → Move 屏幕上显示了 6 位配对码，报给我
你:  438217
AI:  [move_pair code=438217] → 已配对 ✅
你:  生成一个 120bpm 的 dusty kick，然后发到 Move 上
AI:  [generate_audio] → [move_upload_sample] → kick.wav 已在 Move 的
     Samples 文件夹，装上鼓垫就能用
```

说明：

- Move 和电脑必须在**同一 WiFi**；主机名默认 `move.local`（改过名的话在
  `move_pair` 里传入新主机名或 IP）。
- 上传/下载会在聊天界面弹确认（和其他改动类工具一样）；配对和浏览直接执行。
- 如果调用开始报"未配对"，说明令牌过期——重新配对即可。
