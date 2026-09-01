<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  An AI assistant inside <b>Ableton Live 12</b> — Claude, Codex, or Gemini, your call.<br>
  Chat, generate MIDI, load drum kits, search samples, and control devices &<br>
  tracks without leaving your session.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/v/release/freddyzhangxu/aibleton?include_prereleases&label=version" alt="Version"></a>
  <a href="https://github.com/freddyzhangxu/aibleton/releases"><img src="https://img.shields.io/github/downloads/freddyzhangxu/aibleton/total" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

---

## Download

**Current version: v0.8.9** (pre-release) — get it from the
[**Releases page**](https://github.com/freddyzhangxu/aibleton/releases):

| File | What it is |
|---|---|
| [AIbleton-0.8.9.ablx](https://github.com/freddyzhangxu/aibleton/releases/download/v0.8.9/AIbleton-0.8.9.ablx) | The Live extension — **required**. Drop it onto Live's **Settings → Extensions** page. |
| [AIbletonBar-0.8.9-macOS.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.8.9/AIbletonBar-0.8.9-macOS.zip) | Optional macOS floating sidebar app (version kept in sync with the extension). |
| [AIbletonBar-0.8.9-Windows.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.8.9/AIbletonBar-0.8.9-Windows.zip) | Optional Windows floating sidebar app — toggle with Win+Alt+A (version kept in sync with the extension). |

No Node.js needed for end users — the extension runs inside Live's own Extension Host.

## Overview

AIbleton brings an AI chat assistant directly into Ableton Live. Ask it to *"make a
4-bar 808 pattern at 140 BPM"*, *"add an Auto Filter on track 2 and sweep the cutoff
to 800 Hz"*, or *"find a tech-house loop in my samples and drop it on the arrangement"* —
and it happens in your Live Set.

It's also an operation guide while you work: ask *"how do I sidechain-compress the
bass against the kick?"* or *"where do I set up warping for this loop?"* and it walks
you through the steps — or simply does it for you.

The project has two parts:

| Component | What it is |
|---|---|
| **[AIbleton/](AIbleton/)** | The Live 12 extension: chat UI + a local assistant server with ~20 tools that read and control the Live Set |
| **[AIbletonBar/](AIbletonBar/)** | A native floating sidebar (macOS & Windows) that hosts the same chat UI next to Live — IDE-style, toggled with **⌥⌘A** / **Win+Alt+A** |

## Screenshots

| AI assistant dialog inside Live | AIbletonBar floating sidebar |
|:---:|:---:|
| ![AIbleton chat dialog inside Ableton Live](docs/screenshots/aibleton-dialog.png) | ![AIbletonBar sidebar docked next to Ableton Live](docs/screenshots/aibletonbar-sidebar.png) |

## Features

- **Chat inside Live** — right-click any track / scene / clip → Extensions →
  **AIbleton: Open** opens the assistant in a modal dialog. The same UI is also reachable at `http://localhost:17666` from any
  browser, and from AIbletonBar.
- **Your choice of model** — Claude, OpenAI Codex, or Google Gemini, switchable in the
  dialog. Credentials are reused from the matching local CLI (Claude Code, Codex CLI
  including ChatGPT-account sign-in, Gemini CLI) or entered by hand, and a reasoning-effort
  selector trades speed for deeper thinking when you need it.
- **File attachments** — attach images or text files, or drop in a `.mid` file or a whole
  `.als` Live Set: binary music files are parsed into compact text summaries the model
  can read, so you can ask *"what key is this loop in?"* or *"recreate this bass line
  on track 3"*. Click to pick, drag into the window, or ⌘V paste.
- **MIDI generation & editing** — write arrangement or Session-View clips from natural
  language, or read and rework the notes of existing clips — per-note pitch / timing /
  velocity, with swing support.
- **One-shot 808 kit** — builds a Drum Rack with Simpler pads loaded with real factory
  808 samples, ready to program against a GM-style note map.
- **Sample search & import** — searches your local Splice sync folder, Ableton User
  Library, Factory Packs and Core Library, then imports audio or loads samples into Simpler.
- **AI audio generation** — renders text prompts into audio with Stable Audio,
  ElevenLabs, MiniMax, or any custom HTTP API (relays, self-hosted MusicGen,
  Suno-style services — sync or async) and drops the result straight into your
  Set: loops onto the arrangement, one-shots into a Simpler. Files land in your
  User Library, ready to reuse and search.
- **Device control** — insert devices (Operator, Auto Filter, …), read and set parameters
  by fuzzy name ("freq" → Filter Freq).
- **Track & scene operations** — create / rename / mute / solo / arm tracks, set volume
  & pan, create and rename scenes, set tempo.
- **Operation guidance** — answers how-to questions about Live itself (mixing, warping,
  routing, shortcuts…) with step-by-step instructions, right where you're working.
- **Localized UI** — the chat interface speaks English, 中文, Deutsch, Français,
  日本語, Español and Italiano, matching Live's own language list.

## Requirements

- **Ableton Live 12** (12.4.5+) with the Extensions SDK beta
- **Node.js ≥ 24.14.1** — developers only, for building from source. End users
  installing the `.ablx` do *not* need Node.js (the extension runs inside Live's own
  Extension Host)
- **An AI provider** — Claude, OpenAI Codex, or Google Gemini. Credentials are reused
  automatically from the matching local CLI: Claude Code's `~/.claude/settings.json`,
  Codex CLI's `~/.codex/auth.json` (API key or ChatGPT-account sign-in), Gemini CLI's
  `~/.gemini/.env`. You can also use environment variables (`ANTHROPIC_*`, `OPENAI_*`,
  `GEMINI_API_KEY` / `GOOGLE_API_KEY`) or enter everything in the dialog's
  **Settings → AI Provider** section. Nothing sensitive is stored by the extension.
- **macOS or Windows** — only needed for AIbletonBar; the extension itself is platform-independent

## Installation

### For users — install the `.ablx`

Requires **Ableton Live 12.4.5 beta** or later. Download
[AIbleton-0.8.9.ablx](https://github.com/freddyzhangxu/aibleton/releases/download/v0.8.9/AIbleton-0.8.9.ablx),
then open Live's **Settings → Extensions** page and drag the `.ablx` file onto it —
no Node.js, no terminal.

Once installed: right-click a track, scene or clip → Extensions → **AIbleton: Open** —
or open `http://localhost:17666` in a browser.

### For developers — build & run from source

```sh
cd AIbleton
npm install

# .env must point EXTENSION_HOST_PATH at Live's Extension Host module
# (the SDK generator fills this in; edit it if your install moves)

npm start        # build + run inside Live's Extension Host
```

Then in Live: right-click a track, scene or clip → Extensions → **AIbleton: Open** — or open
`http://localhost:17666` in a browser.

### Scripts

```sh
npm start          # dev build + run in Live
npm run build      # production bundle of src/extension.ts
npm run build:dev  # dev bundle (sourcemaps, not minified)
npm run package    # production build + create a distributable .ablx archive
```

### AIbletonBar (optional sidebar)

macOS:

```sh
cd AIbletonBar
./build.sh            # compiles AIbletonBar.app (swiftc, no dependencies)
open AIbletonBar.app
```

Windows (cross-builds from macOS, needs the .NET SDK; also works in Git Bash on Windows):

```sh
cd AIbletonBar/windows
./build.sh            # publishes a single-file AIbletonBar.exe (WinForms + WebView2)
```

- **⌥⌘A** (macOS) / **Win+Alt+A** (Windows) toggles the panel globally; it docks
  to the right edge of the screen and stays on top (follows you across Spaces on macOS).
- Supports the chat's file attachments with a native file picker.
- Shows an offline placeholder when the extension isn't loaded in Live, and
  reconnects automatically (3 s polling).

## How it works

The extension starts a small HTTP server (port `17666`) inside Live's Extension Host.
The chat page talks to the selected provider — Claude, Codex, or Gemini — with a tool
set backed by the Extensions SDK: `get_song_overview`, `write_midi_clip`,
`write_session_clip`, `load_drum_kit`, `search_samples`, `import_audio_clip`,
`insert_device`, `set_device_parameter`, `set_track_mixer`, scene & tempo tools, and
more. Every answer can directly read and modify the open Live Set.

```
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────┐
│ Chat UI            │      │ Assistant server     │      │ Model API      │
│ (dialog / browser  │─────▶│ localhost:17666      │─────▶│ Claude / Codex │
│  / AIbletonBar)    │      │ + ~20 Live tools     │◀─────│ / Gemini       │
└────────────────────┘      └──────────┬───────────┘      └────────────────┘
                                       │ Extensions SDK
                                       ▼
                              ┌──────────────────┐
                              │ Ableton Live 12  │
                              │ (open Live Set)  │
                              └──────────────────┘
```

## Project structure

```
AIbleton/          Live extension (TypeScript)
├── src/extension.ts   entry point — registers context-menu actions, starts server
├── src/server.ts      assistant server + tool implementations (Claude / Codex / Gemini)
├── src/fileparsers.ts parses .mid / .als attachments into text summaries for the model
├── ui/interface.html  chat UI
├── scripts/           smoke tests (npx tsx scripts/test-fileparsers.ts)
└── vendor/            Extensions SDK beta tarballs (gitignored, see note below)

AIbletonBar/       macOS floating sidebar (Swift, ~180 lines, no deps)
├── main.swift
├── build.sh           swiftc build + ad-hoc sign
└── Resources/         app icon & logo
```

## Status

AIbleton is open source. The Ableton Extensions SDK is still in **beta**, and its
tarballs may not be redistributed — that's why `vendor/` is gitignored. To build the
extension yourself you'll need access to the SDK beta (see
https://ableton.github.io/extensions-sdk/). The beta 1 SDK exposes only context menus
and modal dialogs, which is exactly why AIbletonBar exists as a separate sidebar app.

## Roadmap

- **Deeper Live integration** — move the sidebar into Live itself once the SDK's
  panel APIs land in a stable release.

## Disclaimer

AIbleton is an independent open-source project, not affiliated with or endorsed by
Ableton AG. "Ableton" and "Live" are trademarks of Ableton AG.

## License

[MIT](LICENSE)
