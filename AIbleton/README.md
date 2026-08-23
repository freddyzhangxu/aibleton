# AIbleton

AI assistant inside Ableton Live 12 — chat, generate MIDI, load drum kits, and
control devices (Operator, Auto Filter, …) and tracks directly from a dialog in Live.

Built with `@ableton-extensions/sdk`.

## Get Started

Learn about building extensions: https://ableton.github.io/extensions-sdk/

## Setup

The path to Ableton Live's Extension Host module is stored in `.env` as
`EXTENSION_HOST_PATH`. The generator filled this in for you; edit it if your
install moves.

API credentials are read from `~/.claude/settings.json` (same as Claude Code),
or from `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`, or entered in the dialog's
「高级」section. Nothing sensitive is stored by this extension.

## Scripts

```sh
npm start                  # build + run in Live's Extension Host
npm run build              # production bundle of src/extension.ts
npm run build:dev          # dev bundle (sourcemaps, not minified)
npm run package            # build for production + create a .ablx archive
```

---

AIbleton is an independent open-source project, not affiliated with or endorsed by Ableton AG.
