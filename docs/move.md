# Sequencing Ableton Move from AIbleton

AIbleton can write clips that play on an **Ableton Move** over USB-C — Live acts as
the MIDI hub, Move acts as an external sound module playing its own instruments
(Drift, Drum Sampler, …).

> 中文版本：[move.zh-CN.md](move.zh-CN.md)

## Requirements

| Side | Requirement |
|---|---|
| Move | Firmware **≥ 1.5**, **Standalone Mode** (not Control Live Mode), connected via **USB-C** |
| Live | 12.x with AIbleton ≥ 0.9.3 |
| macOS | If "Ableton Move" doesn't show up as a MIDI port, see *macOS quirk* below |

Firmware 1.5 added "Exchange MIDI with USB Hosts" — that's what lets a DAW send
MIDI to Move's tracks over USB-C. Check **Setup → About** on the unit; update via
Move Manager if needed.

## One-time setup

1. Connect Move via USB-C, power it on in Standalone Mode.
2. Live → **Settings → Link, Tempo & MIDI** → for the **Ableton Move** output port,
   enable **Track** (and **Sync** if you want Live to send MIDI clock).
3. In the chat, ask e.g. *"create a Move track on channel 1"* — AIbleton runs
   `create_move_track`, which creates a MIDI track named `Move Ch 1`.
4. **Manual step (once per Set):** the Extensions SDK cannot set output routing,
   so set that track's **Output Type → Ableton Move**, **Output Channel → 1**
   yourself. Live remembers it in the Set from then on.
5. On Move, pick the receiving track: hold **Shift + press a track button** → set
   **MIDI In** to the same channel (or **Auto**, which accepts every channel not
   explicitly assigned to another track).

Done — ask AIbleton to *"write a 4-bar house groove into the Move track"* and it
lands on Move's instruments.

## What works / what doesn't

| Works | Doesn't work |
|---|---|
| Notes, velocity, poly aftertouch | **MIDI CC** (Move ignores it — no knob automation over MIDI) |
| 4 tracks = 4 MIDI channels | Reading Move's state back into Live |
| MIDI clock sync (enable **Sync** on the port) | Realtime streaming from AIbleton (clips are played by Live's engine) |
| Ableton Link over WiFi as clock alternative | Controlling Move's UI/session remotely |

Notes on note numbers:

- Move drum pads follow the Drum Rack layout from **note 36 (C1)** up.
- Melodic tracks respond to normal pitched notes; per-track MIDI In channels are
  set on the hardware (Shift + track button).

## macOS quirk

If the unit once ran firmware **≤ 1.4.1** while connected to this Mac, macOS keeps
a stale MIDI device entry and the new port configuration never appears:

1. Disconnect Move.
2. Open **Audio MIDI Setup → MIDI Studio**, delete the **Ableton Move** device.
3. Reconnect Move.

## Typical session

```
you:  给我建一条 Move 轨，通道 1
AI:   [create_move_track] → 轨道已建好；请把 Output Type 设为 Ableton Move、
      Output Channel 设为 1（每个 Set 只需一次）
you:  写一段 4 小节 house 鼓
AI:   [write_session_clip] → 已写入，触发 clip 即可在 Move 上听到
```

## File transfer over WiFi (pairing)

AIbleton also talks to the Move Manager's stock HTTP API — no USB cable, no SSH:

| Tool | What it does |
|---|---|
| `move_status` | Reachability, pairing state, firmware version |
| `move_pair` | Pairing handshake (6-digit code on the Move's display) |
| `move_list_sets` | List Sets on the device |
| `move_list_files` | Browse folders/files (Samples, Recordings, …) |
| `move_upload_sample` | Push a local audio file to the Move (default: `Samples`) |
| `move_download_set` | Pull a Set (`.ablbundle`) into the User Library's AIbleton folder |

Pairing is a one-time handshake — the token is persisted by the extension:

```
you:  配对我的 Move
AI:   [move_pair] → Move 屏幕上显示了 6 位配对码，报给我
you:  438217
AI:   [move_pair code=438217] → 已配对 ✅
you:  生成一个 120bpm 的 dusty kick，然后发到 Move 上
AI:   [generate_audio] → [move_upload_sample] → kick.wav 已在 Move 的
      Samples 文件夹，装上鼓垫就能用
```

Notes:

- Move and computer must be on the **same WiFi**; the host defaults to
  `move.local` (pass another hostname/IP to `move_pair` if renamed).
- Uploads and downloads ask for confirmation in the chat UI (like any
  state-changing tool); pairing/listing run straight through.
- If calls start failing with "未配对", the token expired — pair again.
