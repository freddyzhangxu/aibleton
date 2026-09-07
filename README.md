<p align="center">
  <img src="AIbletonBar/Resources/AIbleton.png" alt="AIbleton" width="420">
</p>

<h1 align="center">AIbleton</h1>

<p align="center">
  An open-source agentic music production platform for Ableton Live.<br>
  Chat, create, arrange, edit, and control your music with AI — Codex, Claude, Gemini, or any OpenAI-compatible model.
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

**Current version: v0.9.4** (pre-release) — get it from the
[**Releases page**](https://github.com/freddyzhangxu/aibleton/releases):

| File | What it is |
|---|---|
| [AIbleton-0.9.4.ablx](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.4/AIbleton-0.9.4.ablx) | The Live extension — **required**. Drop it onto Live's **Settings → Extensions** page. |
| [AIbletonBar-0.9.4-macOS.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.4/AIbletonBar-0.9.4-macOS.zip) | Optional macOS floating sidebar app (version kept in sync with the extension). |
| [AIbletonBar-0.9.4-Windows.zip](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.4/AIbletonBar-0.9.4-Windows.zip) | Optional Windows floating sidebar app — toggle with Win+Alt+A (version kept in sync with the extension). |

No Node.js needed for end users — the extension runs inside Live's own Extension Host.

## Overview

AIbleton brings an AI chat assistant directly into Ableton Live. Ask it to *"make a
4-bar 808 pattern at 140 BPM"*, *"add an Auto Filter on track 2 and sweep the cutoff
to 800 Hz"*, or *"find a tech-house loop in my samples and drop it on the arrangement"* —
and it happens in your Live Set.

It's also an operation guide while you work: ask *"how do I sidechain-compress the
bass against the kick?"* or *"where do I set up warping for this loop?"* and it walks
you through the steps — or simply does it for you.

With Stable Audio (or ElevenLabs / MiniMax) connected, it can also render audio from
a one-line description — loops onto the arrangement, one-shots into Simpler.

The project has two parts:

| Component | What it is |
|---|---|
| **[AIbleton/](AIbleton/)** | The Live 12 extension: chat UI + a local assistant server with 30+ tools that read and control the Live Set |
| **[AIbletonBar/](AIbletonBar/)** | A native floating sidebar (macOS & Windows) that hosts the same chat UI next to Live — IDE-style, toggled with **⌥⌘A** / **Win+Alt+A** |

## Screenshots

| AI assistant dialog inside Live | AIbletonBar floating sidebar |
|:---:|:---:|
| ![AIbleton chat dialog inside Ableton Live](docs/screenshots/aibleton-dialog.png) | ![AIbletonBar sidebar docked next to Ableton Live](docs/screenshots/aibletonbar-sidebar.png) |

## Features

- **Chat inside Live** — right-click any track / scene / clip → Extensions →
  **AIbleton: Open** opens the assistant in a modal dialog. The same UI is also reachable at `http://localhost:17666` from any
  browser, and from AIbletonBar.
- **Your choice of model** — OpenAI Codex, Claude, Google Gemini, or any
  OpenAI-compatible endpoint (Grok, DeepSeek, OpenRouter, Ollama…), switchable in
  the dialog. Credentials for the big three are reused from the matching local CLI
  (Codex CLI including ChatGPT-account sign-in, Claude Code, Gemini CLI) or entered
  by hand; the Custom slot takes a base URL + model and speaks plain
  `/chat/completions` (API key optional for local servers). A reasoning-effort
  selector trades speed for deeper thinking when you need it.
- **Artist memory** — tell the assistant about your style once (*"I make melodic
  techno around 124, A minor, warm analog pads"*) and it remembers across chats:
  the memory lives in a plain `memory.json` next to the settings file, is
  injected into every conversation as the defaults for musical decisions, and the
  assistant adds to it itself via the `update_memory` tool whenever you state a
  durable preference. View and edit it anytime in Settings → Artist Memory, or
  hand-edit and share the file directly.
- **File attachments** — attach images or text files, or drop in a `.mid` file or a whole
  `.als` Live Set: binary music files are parsed into compact text summaries the model
  can read, so you can ask *"what key is this loop in?"* or *"recreate this bass line
  on track 3"*. Click to pick, drag into the window, or ⌘V paste.
- **MIDI generation & editing** — write arrangement or Session-View clips from natural
  language, or read and rework the notes of existing clips — per-note pitch / timing /
  velocity, with swing support.
- **Set analysis & one-call arranging** — `analyze_song` reads the open Set: detected
  key, per-track roles, note/density stats, section structure, rule-based issues,
  and a flat clip map with every clip's coordinates. `arrange_song` then builds or
  rebuilds the arrangement from a placement plan in ONE call — validated before
  anything changes (bad references abort with zero writes), executed as a single
  undo step, with a `dry_run` preview and an optional bar-range clear for rebuilds.
- **One-shot 808 kit** — builds a Drum Rack with Simpler pads loaded with real factory
  808 samples, ready to program against a GM-style note map.
- **Sample search & import** — searches your local Splice sync folder, Ableton User
  Library, Factory Packs and Core Library, then imports audio or loads samples into
  Simpler. BPM and key are parsed from file/folder names at index time (gear numbers
  like "808" excluded), queries get synonym expansion (*dark* → rumble/industrial/sub…),
  and results rank by exact BPM/key > near BPM > relative major/minor > keywords.
- **AI audio generation** — renders text prompts into audio with Stable Audio,
  ElevenLabs, MiniMax, or any custom HTTP API (relays, self-hosted MusicGen,
  Suno-style services — sync or async) and drops the result straight into your
  Set: loops onto the arrangement, one-shots into a Simpler. Files land in your
  User Library, ready to reuse and search.
- **Web access (opt-in)** — off by default; flip it on in Settings → Web
  Search and the assistant can search the web (`web_search`, keyless — Bing
  with DuckDuckGo fallback, localized to your UI language) and read pages
  (`web_fetch`), so it answers current-info questions — release notes, prices,
  tutorials — and summarizes URLs you paste, with sources cited. Read-only and
  confirmation-free; honors your proxy settings.
- **Device control** — insert devices (Operator, Auto Filter, …), read and set parameters
  by fuzzy name ("freq" → Filter Freq).
- **Track & scene operations** — create / rename / mute / solo / arm tracks, set volume
  & pan, create and rename scenes, set tempo.
- **Ableton Move support** — two-way integration with the Move hardware:
  `create_move_track` sets up a MIDI track that sequences a Move over USB-C
  (firmware ≥ 1.5, Standalone Mode), and a WiFi file pipeline (`move_pair` /
  `move_upload_sample` / `move_download_set` / list tools) pushes AI-generated
  samples straight onto the device and pulls Sets back — stock firmware, no SSH.
  `move_analyze_set` downloads a Set and runs the same analysis engine as
  `analyze_song` — key, track roles, issues — plus Move extras: mixer levels,
  device chains, and the sample list with durations and pack/user origin.
  One-time manual output routing per Set — see [docs/move.md](docs/move.md).
- **Operation guidance** — answers how-to questions about Live itself (mixing, warping,
  routing, shortcuts…) with step-by-step instructions, right where you're working.
- **Localized UI** — the chat interface speaks English, 中文, Deutsch, Français,
  日本語, Español and Italiano, matching Live's own language list.

## Requirements

- **Ableton Live 12** (12.4.5+) with the Extensions SDK beta
- **Node.js ≥ 24.14.1** — developers only, for building from source. End users
  installing the `.ablx` do *not* need Node.js (the extension runs inside Live's own
  Extension Host)
- **An AI provider** — OpenAI Codex, Claude, Google Gemini, or any OpenAI-compatible
  endpoint (Grok, DeepSeek, OpenRouter, Ollama…). Credentials are reused automatically
  from the matching local CLI: Codex CLI's `~/.codex/auth.json` (API key or
  ChatGPT-account sign-in), Claude Code's `~/.claude/settings.json`, Gemini CLI's
  `~/.gemini/.env`. You can also use environment variables (`OPENAI_*`, `ANTHROPIC_*`,
  `GEMINI_API_KEY` / `GOOGLE_API_KEY`) or enter everything in the dialog's
  **Settings → AI Provider** section — the Custom slot needs just a base URL and a
  model (key optional for local servers). Nothing sensitive is stored by the extension.
- **macOS or Windows** — only needed for AIbletonBar; the extension itself is platform-independent

## Installation

### For users — install the `.ablx`

Requires **Ableton Live 12.4.5 beta** or later. Download
[AIbleton-0.9.4.ablx](https://github.com/freddyzhangxu/aibleton/releases/download/v0.9.4/AIbleton-0.9.4.ablx),
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
The chat page talks to the selected provider — Codex, Claude, Gemini, or a custom
OpenAI-compatible endpoint — with a tool set backed by the Extensions SDK:
`get_song_overview`, `analyze_song`, `arrange_song`, `write_midi_clip`,
`write_session_clip`, `load_drum_kit`, `search_samples`, `import_audio_clip`,
`generate_audio`, `insert_device`, `set_device_parameter`, `set_track_mixer`,
scene & tempo tools, the Ableton Move tools, and more — plus `web_search` /
`web_fetch` for keyless web access. Every answer can directly read and modify the
open Live Set.

```
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────┐
│ Chat UI            │      │ Assistant server     │      │ Model API      │
│ (dialog / browser  │─────▶│ localhost:17666      │─────▶│ Codex / Claude │
│  / AIbletonBar)    │      │ + 30+ Live tools     │◀─────│ Gemini / any   │
└────────────────────┘      │                      │      │ OpenAI-compat. │
                            │                      │      └────────────────┘
                            │                      │      ┌────────────────┐
                            │                      │─────▶│ Audio API      │
                            │                      │◀─────│ Stable Audio / │
                            └──────────┬───────────┘      │ ElevenLabs /   │
                                       │ Extensions SDK   │ MiniMax /      │
                                       ▼                  │ custom HTTP    │
                              ┌──────────────────┐        └────────────────┘
                              │ Ableton Live 12  │
                              │ (open Live Set)  │
                              └──────────────────┘
```

`generate_audio` is a separate provider stack from the chat model — its own API
keys (Settings → Audio Generation), called directly by the server, never routed
through the LLM. Renders land in User Library › AIbleton, then the model drops
them into the Set with `import_audio_clip` / `load_sample`.

## Project structure

```
AIbleton/          Live extension (TypeScript)
├── src/extension.ts   entry point — registers context-menu actions, starts server
├── src/server.ts      assistant server + tool implementations (Codex / Claude / Gemini / OpenAI-compatible)
├── src/analysis.ts    analyze_song engine — key/role/issue detection + the clip map arrange_song plans against
├── src/audiogen.ts    audio generation providers (Stable Audio / ElevenLabs / MiniMax / custom HTTP)
├── src/websearch.ts   web_search (Bing + DuckDuckGo fallback, keyless) + web_fetch, proxy-aware
├── src/samplemeta.ts  BPM/key filename parsing + synonym expansion + ranking for search_samples
├── src/fileparsers.ts parses .mid / .als attachments into text summaries for the model
├── src/move.ts        Ableton Move WiFi file pipeline (pair / upload / download / list)
├── src/movebundle.ts  .ablbundle parser + Move Set → snapshot converter for move_analyze_set
├── ui/interface.html  chat UI
├── scripts/           smoke tests (npx tsx scripts/test-*.ts; smoke-samplelib.ts runs against your real library)
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
