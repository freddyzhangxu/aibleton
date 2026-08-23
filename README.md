<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  A Claude-powered AI assistant inside <b>Ableton Live 12</b> — chat, generate MIDI,<br>
  load drum kits, search samples, and control devices & tracks without leaving your session.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">中文</a>
</p>

---

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
| **[AIbletonBar/](AIbletonBar/)** | A native macOS floating sidebar that hosts the same chat UI next to Live — IDE-style, toggled with **⌥⌘A** |

## Features

- **Chat inside Live** — right-click any track / scene / clip → `打开…` opens the assistant
  in a modal dialog. The same UI is also reachable at `http://localhost:17666` from any
  browser, and from AIbletonBar.
- **MIDI generation** — write arrangement or Session-View clips from natural language,
  with per-note pitch / timing / velocity and swing support.
- **One-shot 808 kit** — builds a Drum Rack with Simpler pads loaded with real factory
  808 samples, ready to program against a GM-style note map.
- **Sample search & import** — searches your local Splice sync folder, Ableton User
  Library, Factory Packs and Core Library, then imports audio or loads samples into Simpler.
- **Device control** — insert devices (Operator, Auto Filter, …), read and set parameters
  by fuzzy name ("freq" → Filter Freq).
- **Track & scene operations** — create / rename / mute / solo / arm tracks, set volume
  & pan, create and rename scenes, set tempo.
- **Operation guidance** — answers how-to questions about Live itself (mixing, warping,
  routing, shortcuts…) with step-by-step instructions, right where you're working.

## Requirements

- **Ableton Live 12** (12.4.5+) with the Extensions SDK beta
- **Node.js ≥ 24.14.1**
- **Claude API access** — reused automatically from Claude Code's `~/.claude/settings.json`,
  or via `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`, or entered in the
  dialog's「高级」section. Nothing sensitive is stored by the extension.
  *(Claude is the only provider for now — Codex & Gemini support is on the [Roadmap](#roadmap).)*
- **macOS** — only needed for AIbletonBar; the extension itself is platform-independent
  *(a Windows version of AIbletonBar is planned)*

## Setup

```sh
cd AIbleton
npm install

# .env must point EXTENSION_HOST_PATH at Live's Extension Host module
# (the SDK generator fills this in; edit it if your install moves)

npm start        # build + run inside Live's Extension Host
```

Then in Live: right-click a track, scene or clip → **打开…** — or open
`http://localhost:17666` in a browser.

### Scripts

```sh
npm start          # dev build + run in Live
npm run build      # production bundle of src/extension.ts
npm run build:dev  # dev bundle (sourcemaps, not minified)
npm run package    # production build + create a distributable .ablx archive
```

### AIbletonBar (optional sidebar)

```sh
cd AIbletonBar
./build.sh            # compiles AIbletonBar.app (swiftc, no dependencies)
open AIbletonBar.app
```

- **⌥⌘A** toggles the panel globally; it docks to the right edge of the screen,
  stays on top, and follows you across Spaces.
- Shows an offline placeholder when the extension isn't loaded in Live, and
  reconnects automatically (3 s polling).

## How it works

The extension starts a small HTTP server (port `17666`) inside Live's Extension Host.
The chat page talks to Claude with a tool set backed by the Extensions SDK —
`get_song_overview`, `write_midi_clip`, `write_session_clip`, `load_drum_kit`,
`search_samples`, `import_audio_clip`, `insert_device`, `set_device_parameter`,
`set_track_mixer`, scene & tempo tools, and more. Every answer can directly read and
modify the open Live Set.

```
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────┐
│ Chat UI            │      │ Assistant server     │      │ Claude API     │
│ (dialog / browser  │─────▶│ localhost:17666      │─────▶│ (tool use)     │
│  / AIbletonBar)    │      │ + ~20 Live tools     │◀─────│                │
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
├── src/server.ts      assistant server + tool implementations
├── ui/interface.html  chat UI
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

- **More model providers** — the assistant currently runs on Claude; support for
  OpenAI Codex and Google Gemini is planned.
- **AIbletonBar for Windows** — the floating sidebar is macOS-only today; a Windows
  version is on the list.
- **Deeper Live integration** — move the sidebar into Live itself once the SDK's
  panel APIs land in a stable release.

## Disclaimer

AIbleton is an independent open-source project, not affiliated with or endorsed by
Ableton AG. "Ableton" and "Live" are trademarks of Ableton AG.

## License

[MIT](LICENSE)
