# AIbleton User Guide

> This English-language guide is for music producers and reflects the actual interface and capabilities of AIbleton.

> Chinese edition: [AIbleton 用户指南](docs/USER_GUIDE_CN.md).

AIbleton is an AI music-production assistant that runs inside Ableton Live. You can talk to it as you would a production partner: ask it to understand your current Set, make suggestions, or directly create, edit, arrange, mix, and analyze material.

## Quick Start

1. Save the current Set as a new version, then open AIbleton.
2. Turn **YOLO** off beside the input, choose a provider in **Settings → AI Provider**, and confirm connectivity with: `What tracks are currently in the Set?`
3. Make one small change only, such as the 4-bar drum-groove example in this guide. Check every **Allow** prompt, audition the result, and use Live Undo if needed.
4. For rearrangement, request a plan and a dry run. For audio generation, begin with a short prompt, watch the provider-side cost, and leave auto-iteration off until you know the direction you want.

## 1. Before You Start

### Requirements

- Ableton Live **12.4.5 or later**, with support for the Ableton Extensions SDK.
- The AIbleton `.ablx` extension installed. In Live, open **Settings → Extensions** to install it.
- Valid authentication for at least one AI provider. Chat supports Codex, Claude Code, Gemini, and OpenAI-compatible services.
- To generate new audio, you will also need an API key for Stable Audio, ElevenLabs, MiniMax, or a custom HTTP audio service.
- To use factory drum kits such as 808 / 909, install the local **Drum Essentials Pack**. AIbleton does not download missing samples automatically.
- To use AIbletonBar, install the optional macOS / Windows sidebar for your platform. You can still use AIbleton directly in Live without the sidebar.

### First-Launch Checklist

1. Open AIbleton in Live.
2. Check the status at the top of the window. If it says no authentication was found, click the gear in the upper-right corner and open **AI Provider**.
3. Select a provider and enter an API Key; enter an API endpoint and model name if needed. If left blank, Codex / Claude / Gemini will first try existing local CLI or environment configuration.
4. Send a question that does not change the Set, such as `What tracks are currently in the Set?`, to confirm that AI can return an overview of the current project.

If you use the **Custom** provider, you must enter both an API endpoint and a model. Local services (such as Ollama) may not require an API Key, depending on the service. AIbleton communicates with Custom services using the OpenAI-compatible chat/completions protocol.

> **For your first session, do this:** First save the Set as a new version, turn off YOLO, and send a read-only question to confirm the connection works. Limit your first actual change to just 4 bars. That makes it easy to audition, undo, and compare if you do not like the result.

## 2. Getting to Know the Interface

| Area | How to use it |
|---|---|
| Top bar | `+` starts a new conversation; the clock icon opens history; the gear opens settings. Closing the dialog does not stop a task already running in the background. |
| Input | Press `Enter` to send and `Shift+Enter` for a line break. Describe your musical goal; you do not need to write tool names or JSON. |
| Model / Effort | Click the model name to go directly to AI Provider. Higher Effort usually allows more thorough reasoning, but takes longer. Custom providers do not show Effort because there is no common standard. |
| Attachments | Click the paperclip, drag items into the window, or paste images / files. See “Attachments and References” for details. |
| YOLO | When enabled, AI can directly perform non-paid actions. When disabled, every action that changes the Set presents **Allow / Deny**. The confirmation bar shows only a summary, so before important changes you should still ask AI to explicitly list the target tracks, range, and files. |
| Send / Stop | While a task is running, the send arrow becomes a stop button. Stopping cancels pending requests and confirmations, but does not automatically undo Live changes that have already completed. |

## 3. Configuring How You Work

### AI Providers and Language

Under **Settings → AI Provider**, choose:

- **Codex**: the default model is `gpt-5-codex`.
- **Claude Code**: the default model is `claude-sonnet-5`.
- **Gemini**: the default model is `gemini-flash-latest`.
- **Custom**: for compatible endpoints such as Grok, DeepSeek, Kimi, OpenRouter, Ollama, and vLLM; enter your own API endpoint and model.

Under **Settings → Language**, you can change the interface and response language. Your model, provider, language, and commonly used settings are saved and restored when you reopen the interface.

### YOLO and Confirmations

YOLO is enabled by default. It works well for operations you already know you want and can quickly undo. For first-time use or major rearrangements, it is best to turn it off first:

1. Turn off the **YOLO** switch to the right of the input field.
2. Each time AI is about to modify the Live Set, it will show the tool name and key parameters.
3. After confirming the contents, target tracks, and range, press **Allow**. Press **Deny** to skip that step.

The initial audio generation for a request asks for confirmation whether YOLO is on or off, because it consumes external API credits. The prompt shows the provider and duration, not necessarily a price. Set a spend cap or usage alert with your provider before enabling auto-iteration. If you enable it, you are pre-authorizing up to 3 additional paid generations for the same goal; those later generations will not each show another confirmation.

## 4. Your First Success: From an Empty Track to an Audible Groove

Start with a small, verifiable task:

1. Create or open a Set.
2. Enter: `Create a MIDI track called Drums, load a 909 drum kit, and write a 4-bar 124 BPM house groove.`
3. AI creates the track, loads a Drum Rack with real samples, and writes a MIDI clip. If it reports that Drum Essentials or samples are missing, install the relevant Pack and try again.
4. Listen to the result, then enter: `Keep the kick unchanged, make the hats groove more, with a slight swing.`
5. To go back, use Live’s Undo directly (⌘Z / Ctrl+Z).

This prompt specifies the role, goal, length, tempo, and style. Compared with “make some house drums,” constraints like these make first results more reliable.

## 5. How to Tell AI What You Need

### What a Good Prompt Includes

Provide the following as needed; you do not have to include everything every time:

- **Goal**: create, analyze, modify, arrange, mix, or prepare for export.
- **Subject / range**: track name, section, starting bar, duration.
- **Musical constraints**: BPM, key, style, reference direction, instruments, energy, and complexity.
- **Protection rules**: what must not change, such as “do not touch the kick” or “keep the tempo and key.”
- **Acceptance criteria**: for example, “the Drop has more energy than the Intro” or “the bass is simpler while retaining the downbeats.”

### Ready-to-Use Prompts

| Goal | Example |
|---|---|
| Understand the project | `Analyze the current Set: its key, sections, the role of each track, and the two issues most worth addressing first.` |
| Create a bassline | `Write a 4-bar, 124 BPM melodic techno bassline in A minor; place it at bar 1 and leave room for the kick.` |
| Edit existing material | `Keep the sound and length of the Bass track, but make the melody use fewer notes and breathe more.` |
| Arrange | `Arrange the existing clips into a 64-bar structure: 16 bars of intro, 16 bars of build, and 32 bars of drop; give me a plan and dry run first.` |
| Starting point for a mix | `Check the relationship between Kick, Bass, and Pad; make only conservative volume and panning adjustments, and do not add tracks.` |
| Sound design | `Add Auto Filter to Synth and create a rising feeling from dark to bright; check the parameter ranges first, then make only small changes.` |
| Find a sample | `Find a 124 BPM, A minor, dark pad loop; list candidates first and do not import anything.` |
| Generate audio | `Generate an 8-second seamless industrial percussion loop with no vocals, at 124 BPM in A minor, and place it on the Texture audio track at bar 33.` |

### Ask First, Then Act

These two phrasings are especially useful for major changes:

```text
Analyze the current arrangement first. Only tell me how to make the Drop hit harder; do not change the Set yet.

Rearrange a Drop for bars 33–64: give me a plan and dry run first; execute only after I confirm.
```

When a task involves multi-step creation, arrangement, or repair, AI first establishes checkable goals and plans the steps. You can always ask it to remain at the analysis / planning stage, or ask which tracks it is preparing to modify.

## 6. Common Production Workflows

### A. Analyze First, Then Change the Arrangement

1. Say: `Analyze the current Set’s sections, track roles, energy contrast, and repetition issues.`
2. Ask AI to explain the issues from its analysis. Do not treat that analysis as an aesthetic verdict; listen first and decide what you want.
3. State a clear goal: `Make the Drop more energetic than the Intro, while keeping the existing kick and tempo unchanged.`
4. For multi-step changes, ask: `Give me a plan first.`
5. After execution, listen again to the key transitions, then ask AI for a narrowly scoped refinement.

AI’s structural analysis prioritizes Live cue points. If there are no cue points, it infers sections from 8-bar energy blocks. If you want to work consistently with `Intro / Build / Drop`, use meaningful cue names in Live.

### B. Rearrange the Arrangement from Existing Clips

When asking AI to rearrange, do not say only “arrange it.” Specify the range and preservation strategy first:

```text
Analyze all Arrangement and Session clips, then rearrange bars 1–64 using the existing material.
Preserve the source material; dry run first and list the source, destination bar, and conflicts for every placement.
```

A dry run does not modify the Set. Before actual execution, check:

- Whether the source track / clip for each placement is correct;
- Whether clip overlap occurs on the same track;
- Whether you really want to clear the entire range on every track.

> **Range-clearing warning:** A full-range clear affects the specified bars on **all tracks** (including the start and end bars), and trims clips that intersect the range. If a source itself falls within the cleared range, AI can create a new placement from content it has already read, but the original Arrangement source clip will still be cleared. A dry run can preview the action but cannot restore a clear that has already been executed; use Live Undo after actual execution to go back. Use it only when you explicitly intend to “rebuild this section.”

### C. Drums, Melodies, and MIDI Editing

- Drums: ask AI to load an `808` / `909` / `707` / `606` / `DMX` kit before writing a pattern. Use the pad names AI reports after loading the kit; they identify the pitches available in that kit.
- Melodies: specify the key, octave range, note density, and section. For example: `Write a 4-bar bass in A minor between C2–C3, mainly using eighth notes.`
- Editing an existing clip: first ask AI to read or analyze it, then specify whether to “replace all notes” or “keep the rhythm and change only pitch.” When editing an Arrangement MIDI clip, writing replaces the entire set of notes; it does not merge automatically.
- Swing: AI bakes swing into note timing / velocity; it does not assign a Live Groove file to the clip.

### D. Devices and Basic Mixing

Describe the listening problem first, then limit the scope of the changes:

```text
The Pad is too bright and masks the lead. Only insert or adjust built-in devices on the Pad track; check parameters first,
then use EQ Eight or Auto Filter for gentle treatment. Do not change the notes.
```

AI can operate Live’s built-in devices (such as Operator, Wavetable, Impulse, Reverb, Auto Filter, Compressor, EQ Eight, and Delay), but does not support third-party plug-ins. For complex devices, ask AI to inspect the available controls before making a few small changes. When multiple controls need adjustment at once, AI will usually apply them together.

AIbleton’s track-volume value is normalized from 0–1, where approximately `0.85 ≈ 0 dB`; it is not a direct dB input. It changes only volume / pan, and does not write automation, sends, or the master chain.

### E. Finding and Using Samples

1. First say: `Find a 124 BPM, A minor, warm pad loop.`
2. Ask AI to show candidate paths first; confirm the style and file before importing.
3. To place a loop / stem in the Arrangement: `Import the second candidate to the Texture audio track at bar 33, with warp enabled.`
4. For playable one-shots such as bass hits, vocal chops, and stabs: `Load the first candidate into Simpler on the Vocal Chop track.`

Local search checks synced Splice content, the Ableton User Library, Factory Packs, and the Core Library; it does not browse the online Splice catalog. An Arrangement import target must be an **Audio track**; a one-shot loaded into Simpler is played from a MIDI track.

### F. Generating and Iterating on New Audio

Under **Settings → Audio Generation**, select a provider and enter its key. Start with short, verifiable material:

```text
Generate an 8-second seamless loop: 124 BPM, A minor, dry industrial percussion,
no vocals. After generating, import it directly to the Texture audio track at bar 33.
```

- Prompts are currently most reliable in **English** and should include genre, BPM, key, instruments, and mood.
- Use `seamless loop` for loops; 4–16 seconds is usually enough. Total duration may be 1–190 seconds.
- `instrumental` can request no vocals; lyrics apply only to MiniMax.
- Generated files are saved in AIbleton’s folder in the User Library, so you can refer to and refine a previous result.
- **Cost and retry warning:** generation can still be billed even if the later import fails. The generated file is retained; when possible, retry the import rather than generating the audio again.

“Auto-iteration” is appropriate for generation tasks with a clear, measurable goal. It is not appropriate to enable blindly while you are still exploring a style. Turning it on means pre-authorizing up to 3 additional paid generations for the same goal, with no confirmation for each later generation; set a duration and budget first, then audition every result.

## 7. References, Attachments, Search, and Memory

### Attachments

You can click, drag and drop, or paste up to 10 attachments:

- Images: PNG, JPEG, WebP, GIF; no more than 2 MB each.
- Text: txt, md, JSON, CSV, code, YAML, and more; no more than 2 MB each. At most the first 20,000 characters of text are sent to the model.
- MIDI / Live Sets: `.mid` / `.midi` / `.als`; no more than 5 MB each. The system first parses these into text summaries rather than handing the binary projects to the model as-is.

Live’s built-in webview may be unable to open the native file picker. In Live, use drag and drop or paste where possible. If you want to analyze reference audio, give AI the absolute local path to the WAV / AIFF file and the section to compare. References are for analyzing gaps and making conservative recommendations; do not ask it to copy an existing work.

### Web Search

AI can search recent tutorials, versions, release notes, news, and more, and read static webpage content only after you enable **Settings → Web Search**. It is off by default.

Enabling it means your search terms and fetched URLs are sent to the relevant websites; no account or cookies are used. Keep it off when you do not need real-time web information—especially for unreleased artists, clients, tracks, or project names. Local sample files always use AIbleton’s sample search, not web search.

### Artist Memory

Under **Settings → Artist Memory**, enter your artist name, style, BPM range, usual keys, sound preferences, reference artists, and notes. You can also tell AI directly:

```text
Remember that I mainly make 124–128 BPM melodic techno, and I prefer 909 drums and warm analog pads.
```

Artist Memory is included as default creative context in every future chat. Save only stable, long-term preferences; do not store private project names, unreleased-client information, or anything you would not want sent to your provider. For example, choosing A minor for the current Set should not automatically become a permanent preference. To clear or change memory, edit it directly in settings.

## 8. Privacy and Local Storage

AIbleton sends your chat requests, Set information read by tools, and any images / attachments you send to the selected AI provider for processing. Use only projects, samples, and reference material that you are authorized to share. Text attachments enter local chat history; images and binary attachments are used only for the current request. `.mid` / `.als` files are first converted locally into text summaries before being sent.

The extension stores conversation history, producer memory, provider / audio-generation configuration, and the Move pairing token locally so you can continue using it next time. On a shared computer, use a dedicated API key with restricted permissions, avoid uploading unauthorized material, delete conversations you no longer need before leaving the device, and manage credentials carefully in system or extension settings.

## 9. Ableton Move

AIbleton has two separate workflows for Move: **USB-C MIDI sequencing** and **Wi-Fi file / Set management**.

For the complete setup, routing, pairing, and troubleshooting instructions, see the [Ableton Move guide](docs/ableton-move.md).

### USB-C: Make Live Clips Play Through Move

Requirements: Move firmware ≥1.5, Standalone Mode, and a USB-C connection. Enable the Move port once, then set the track routing for each Live Set:

1. In Live, find the Ableton Move output port under **Settings → Link, Tempo & MIDI**. Enable **Track**; also enable **Sync** if you need clock synchronization.
2. Say: `Create a Move track on channel 1.`
3. Following AI’s prompt, manually set that track’s **Output Type** to `Ableton Move` and **Output Channel** to `1` in Live.
4. On Move, hold `Shift` and press the track button, then set that track’s **MIDI In** to the same channel or `Auto`.
5. You can now ask AI to write Arrangement or Session MIDI clips on that track.

This path sends notes, velocity, and poly aftertouch. Move does not receive MIDI CC, and AI cannot automatically set Live Output Routing through the SDK.

### Wi-Fi: Upload Samples and Read or Analyze Move Sets

Your computer and Move must be on the same Wi-Fi. For first-time pairing and uploads:

1. Say: `Check whether my Move is online.`
2. If it is not paired, say: `Pair my Move.`
3. When the Move screen displays a 6-digit code, tell AI the code to finish pairing.
4. Before uploading, say: `List the Samples folder on Move.`
5. Choose an existing destination folder (for example, `Samples/Drums` only if it is listed), confirm any same-named files, then say: `Upload the file I just generated to Move’s Samples folder; do not overwrite files with the same name.`
6. After uploading, confirm the file on Move and audition it.

The pairing token is saved. If it asks you to pair again, simply repeat the code flow. Treat that token as sensitive device-access data: clear or re-pair before handing a shared computer to someone else or selling the device. Uploading is a real write to Move’s file system and **cannot be undone through Live Undo**. Same-named files are not overwritten by default; a file is replaced only when you explicitly request an overwrite. Move has no Arrangement View, so clips read from it are analyzed as Session clips.

For Move Sets, try: `List my Move Sets`, then `Analyze the Set named [name]` or `Download the Set named [name].` Downloaded Sets are saved in AIbleton’s User Library folder for later use.

## 10. History, Skills, and Task Control

- **New conversation**: Click `+`. This is useful when switching to a completely different production goal and avoiding interference from old context.
- **Conversation history**: Click the clock icon to switch or delete conversations. Once deleted, they cannot be restored through the interface, so confirm that you no longer need the context first.
- **Skills**: Type `/` in an empty input field and choose an installed local skill; selecting it inserts `/skill-name`. Skills inject specific workflows or preferences into the current task.
- **Background tasks**: You can close the window while the interface shows “Thinking”; the task continues. To stop it, click the stop button while the task is running. Stopping does not roll back Set writes that have already completed.

## 11. A Safe Way of Working

1. **Start small, then scale up**: Change 4 or 8 bars first; expand to the whole section only when you are satisfied.
2. **State protection rules explicitly**: `Do not change the kick / tempo / key` is more reliable than “don’t change too much.”
3. **Match the protection method to the operation**: For Arrangement rearrangement, turn off YOLO and request a dry run. Other operations have no dry run, so use a small scope, step-by-step confirmation, and a backup instead. For sample overwrites, Move uploads, and external-service generation, also confirm the filename, destination directory, and cost.
4. **Audition every important change**: Tool verification confirms that values were written; it cannot replace your aesthetic judgment.
5. **Make good use of Live Undo**: A complete AIbleton rearrangement plan is usually one Live transaction, so one Undo can usually undo the whole rearrangement.
6. **Do not retry blindly**: If AI says an operation completed but verification did not find the expected result, first ask it to reread the actual state. Repeating the operation can create duplicate clips or notes.
7. **Control generation costs**: Start with short durations and clear prompts. Increase the duration or enable auto-iteration only after you have confirmed a direction you like.

## 12. Troubleshooting

| Symptom | What to check and do |
|---|---|
| The top bar says no authentication was found | Gear → AI Provider: select the correct provider and enter its key; or confirm that the local CLI / environment variable is logged in, then reopen the window. Custom requires both an API endpoint and model. |
| AI only answers and does not change the Set | Check whether your message actually asked it to execute. If the task is at the planning / analysis stage, say “execute now.” When YOLO is off, you also need to click **Allow**. |
| AI waits without doing anything | Check for a confirmation bar. If none appears, use the stop button to cancel, reduce the task scope, and try again. |
| An operation affects the wrong track | First ask AI to `get overview` / analyze the current Set, then refer to tracks by name. Do not keep using old indexes after adding, deleting, or rearranging tracks. |
| Arrangement rearrangement is rejected | Check the dry run: confirm the listed source clip still exists, each destination is valid, and no placements overlap on the same track. Ask AI to analyze the Set again, then create a new plan. |
| Sample import fails | Confirm the file actually exists; the target for a loop / stem must be an Audio track. If a one-shot needs to go into Simpler, use “load into Simpler” instead. |
| A local sample cannot be found | AIbleton can search only installed / synced local libraries. Check whether Splice has finished syncing and whether the User Library / Pack is on this computer. |
| Audio generation reports a key or provider error | Gear → Audio Generation: confirm that the chosen provider matches the key. For Custom, also check the request URL, body template, and response-field path. |
| Generation succeeds but does not appear in the Arrangement | The file has been saved. Ask AI to import it again using the returned file, and confirm that the target is an Audio track. |
| Move says it is unpaired or unreachable | Confirm that both are on the same Wi-Fi and that the device is powered on. Check status first, then start pairing again and enter the code shown on the device screen. |
| Ableton Move MIDI port is not visible on macOS | Disconnect Move, delete the old Ableton Move device in “Audio MIDI Setup → MIDI Studio,” then reconnect it. |

## 13. Next Steps

Once you are comfortable with the basics, try a complete but still controlled task:

```text
Analyze the current Set and identify the energy difference between the Drop and Intro, the bass role, and repetition issues.
The goal is to make the Drop hit harder without changing the tempo, key, or Kick track.
Give me a 3-step plan first; if it involves rearranging the Arrangement, also give me a dry run. Execute after I confirm, and briefly report after each step is complete.
```

This makes full use of AIbleton’s strengths: understand the musical context first, then complete production work through checkable, reversible actions.
