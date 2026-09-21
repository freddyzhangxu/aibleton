import { CRITERION_KINDS, GOAL_TYPES } from "../goal/types.js";
import { EFFECT_METRICS } from "../plan/types.js";
import { toolState } from "../state.js";

// ---------- Claude tool definitions ----------

/** Shared description for the optional track_name param on every track tool. */
export const TRACK_NAME_DESC =
  "Track name as listed by get_song_overview. Always pass it together with the index: " +
  "the pair is verified and the track is re-resolved by name if the index has shifted since.";

/** Optional Live-native per-note expression fields. Kept in one shared schema
 * so every MIDI-writing route speaks the same input language. */
const MIDI_NOTE_PROPERTIES = {
  pitch: { type: "number" },
  start: { type: "number", description: "Note start in beats, relative to clip start" },
  duration: { type: "number", description: "Note length in beats (default 0.25)" },
  velocity: { type: "number", description: "1–127 (default 100)" },
  probability: { type: "number", description: "Optional playback probability, 0–1" },
  velocity_deviation: { type: "number", description: "Optional Live velocity deviation, -127–127" },
  release_velocity: { type: "number", description: "Optional MIDI note-off velocity, 0–127" },
  muted: { type: "boolean", description: "Optional mute flag; preserved in the clip as an alternate note" },
};

/** Flat parameter bag for goal criteria — one schema for every kind keeps it
 * emittable for weak models (no per-kind nesting); the kind-specific required
 * params are enforced server-side in goal/types.ts's normalizeGoal. */
export const CRITERION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...CRITERION_KINDS],
      description:
        "section_energy_gt: section a's note density must exceed b's (a, b = section names; b may be " +
        "\"baseline:<name>\" to compare against the same section's pre-change value). " +
        "section_tracks_gte: a section's active-track count >= n. " +
        "role_present: a role (kick|bass|drums|chords|pad|lead|…, or the group low_end = kick|bass) is audible " +
        "in `section` (whole song when section omitted). " +
        "tempo_unchanged / key_unchanged: self-explanatory (with Scale Mode on, key_unchanged judges Live's " +
        "declared scale — user-set ground truth — not the detected key). " +
        "in_key: at most 15% of note duration outside the governing scale (Live's declared scale when Scale " +
        "Mode is on, else the detected key; drums excluded). off_key_lte: same ratio <= pct (0-1). Both FAIL " +
        "as unmeasurable when no scale is usable or note material is too thin — turn Scale Mode on first if " +
        "the user declared a key. " +
        "track_count_gte: total track count >= n. no_new_tracks: no tracks added. " +
        "tracks_untouched: the named tracks keep identical note content (mixer/device tweaks not covered). " +
        "track_crest_gte: the track's clip SOURCE FILES must reach crest >= db dB (kick punch ≈ 6+ dB). " +
        "track_band_gte: the track's clip SOURCE FILES must have >= pct (0-1) of spectral energy in `band` " +
        "(sub|bass|lowMid|mid|highMid|high). WARNING: the audio kinds judge the source file, pre-warp/pre-gain/" +
        "pre-device — mixer/EQ/compressor/warp edits NEVER move them; only replacing the sample does. Declare " +
        "them only when sample replacement is an acceptable route. " +
        "gen_metric_gte: the LATEST generate_audio artifact's `metric` (rmsDb|peakDb|crestDb|loudnessDb|" +
        "dynamicRangeDb|spectralCentroidHz|transientDensity, or \"band\" with `band`) must be >= value — " +
        "judges the generated file from the generation registry, not the Set. " +
        "gen_improved_vs_prev: the latest generation must improve on the generation that was latest when the " +
        "goal was declared — metric moving `direction` (up|down) by at least min_delta. Fails when no new " +
        "generation happened this turn or either side is unanalyzable (unknown is never \"improved by 0\").",
    },
    a: { type: "string", description: "section_energy_gt: section that must win" },
    b: { type: "string", description: "section_energy_gt: section to beat, or \"baseline:<name>\"" },
    section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
    role: { type: "string", description: "role_present: role name, or group low_end" },
    n: {
      anyOf: [{ type: "number" }, { type: "string" }],
      description: "A number, or \"baseline\" = the value when the goal was declared",
    },
    names: { type: "array", items: { type: "string" }, description: "tracks_untouched: track names" },
    track: { type: "string", description: "track_crest_gte / track_band_gte: track name" },
    db: { type: "number", description: "track_crest_gte: minimum crest factor in dB" },
    band: {
      type: "string",
      description: "track_band_gte: sub | bass | lowMid | mid | highMid | high",
    },
    pct: {
      type: "number",
      description: "track_band_gte: minimum band energy fraction (0-1). off_key_lte: MAXIMUM off-scale duration fraction (0-1)",
    },
    metric: {
      type: "string",
      description:
        "gen_*: rmsDb | peakDb | crestDb | loudnessDb | dynamicRangeDb | spectralCentroidHz | transientDensity | band",
    },
    value: { type: "number", description: "gen_metric_gte: threshold the metric must reach" },
    direction: {
      type: "string",
      enum: ["up", "down"],
      description: "gen_improved_vs_prev: which way counts as improvement",
    },
    min_delta: {
      type: "number",
      description: "gen_improved_vs_prev: minimum improvement over the previous generation",
    },
  },
  required: ["kind"],
};

export const TOOLS = [
  {
    name: "get_song_overview",
    description:
      "Get an overview of the current Live Set: tempo, scale, all tracks (name, type, mute/solo/arm, clips, devices) and scenes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "analyze_song",
    description:
      "Deep read-only musical analysis of the Set: detected key (Krumhansl, duration-weighted, drums excluded) vs Live's scale setting, per-track roles (kick/bass/pad/…) with note/velocity/density/polyphony stats, section structure (cue points, else 8-bar energy blocks), session-view summary, rule-based issues (flat dynamics, low contrast, off-key notes, monotone bass, duplicate tracks, muted content), and a flat clip map (every arrangement clip's track/clip_index/bar/length + every session clip's track/scene_index — the coordinates arrange_song plans against). By default audio clips contribute filename + duration; pass audio:true to decode clip source files (WAV/AIFF) for per-track loudness/crest/dynamic-range/6-band balance and audio-derived issues (weak transients, thin low end, squashed dynamics, dull/harsh top) — features describe the source FILE, pre-warp/pre-gain/pre-device. Call before suggesting structural changes or when you need key/role context. Track indices match get_song_overview. Optional focus narrows the read to what matters for the question.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description:
            "Optional: narrow the analysis to what matters — a track name or role (\"bass\", \"drums\", \"vocal\"), a section name, or an issue code (\"MONOTONE_BASS\"). Focused tracks keep full stats and the clip map keeps only their clips; other tracks collapse to one-line summaries (indices stay valid). Omit for the full read.",
        },
        audio: {
          type: "boolean",
          description:
            "Optional: decode audio clip source files (WAV/AIFF) and add per-track audio features (rms/crest/dynamic-range/loudness/6-band energy/transient density) plus audio-derived issues. Slower on first run (file reads + FFT), cached afterwards. Features describe the source file, pre-warp/pre-gain/pre-device — not the audible result through the device chain.",
        },
      },
    },
  },
  {
    name: "analyze_rendered_track",
    description:
      "Render one Audio Track's arrangement range through Live, then measure the rendered pre-FX audio (RMS, peak, crest, loudness approximation, dynamic range, spectral centroid, transients and 6-band balance). Use when the user explicitly asks about a track's arranged audio rather than its source file. This is read-only and may take time. Pre-FX means it reflects clip timing/content but NOT the track device chain or master processing. Pass start_bar and end_bar together for a precise inclusive range; omit both to render from the track's earliest to latest arrangement Audio Clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "Audio Track index, 0-based" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        start_bar: { type: "number", description: "Optional inclusive start bar (1-based; requires end_bar)" },
        end_bar: { type: "number", description: "Optional inclusive end bar (1-based; requires start_bar)" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "set_goal",
    description:
      "Declare the user's current task as a goal with MACHINE-CHECKABLE success criteria — call it FIRST, " +
      "before any Set-modifying tool, whenever the user asks for a musical change (create/edit/arrange/mix/sound_design/fix). " +
      "The server snapshots the Set as the baseline when you declare; when you stop calling tools it evaluates every " +
      "criterion against the new state, and unmet ones come back as a 目标校验 message (keep working, or explain the " +
      "blocker — never claim completion while criteria are unmet). Criteria are a CLOSED vocabulary: pick a kind and " +
      "fill its parameters — never invent kinds. Use analyze_song first to learn section names, then write 1–4 " +
      "criteria that actually define the outcome (\"make the drop harder\" → section_energy_gt Drop vs Intro + " +
      "role_present low_end in Drop). Skip set_goal for questions, analysis requests, and single-parameter tweaks " +
      "(those results are already verified per-call). The result carries a music block — measured features, " +
      "contrasts and evidence-backed observations relevant to your declared goal; base your criteria thresholds " +
      "and set_plan steps on those numbers, never on guesses.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...GOAL_TYPES] },
        objective: {
          type: "string",
          description: "One human-readable sentence. Shown to the user, NEVER evaluated — only criteria are.",
        },
        target: {
          type: "object",
          properties: {
            track: { type: "string", description: "Track NAME (indices drift, names don't)" },
            section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
          },
        },
        constraints: {
          type: "array",
          description: "Hard boundaries that must still hold at the end (tempo_unchanged, no_new_tracks, tracks_untouched…)",
          items: CRITERION_INPUT_SCHEMA,
        },
        successCriteria: {
          type: "array",
          description: "End-state conditions defining 'done' — 1–4, each must be checkable against the Set's structure",
          items: CRITERION_INPUT_SCHEMA,
        },
        reference: {
          type: "object",
          description:
            "Optional REFERENCE TRACK (local WAV/AIFF file) the goal's target section should be compared against. " +
            "The server analyzes it LOCALLY (never uploaded) and returns a reference block: the aligned reference section, " +
            "measured gaps (energy/density/rhythm/impact…, delta = reference − current), and conservative action hints. " +
            "Reference is EVIDENCE, not the goal: still write your own successCriteria — the gate judges your criteria, " +
            "reference progress is supporting evidence only. Never try to copy or clone the reference.",
          properties: {
            path: { type: "string", description: "Absolute path to the reference audio file (WAV/AIFF)" },
            section: {
              type: "string",
              description: "Optional: pin the reference section to compare against (id from a previous reference block, e.g. \"reference:section:3\")",
            },
            tempo_bpm: { type: "number", description: "Optional tempo hint when the reference's BPM is known — sharpens the beat axis" },
          },
          required: ["path"],
        },
      },
      required: ["type", "objective", "successCriteria"],
    },
  },
  {
    name: "set_plan",
    description:
      "Declare your step-by-step plan for the declared goal — call it AFTER set_goal, BEFORE any Set-modifying " +
      "tool, whenever the task needs 2+ tool calls or multiple stages. Each step names the tool you expect to " +
      "call and the expectedEffects it should produce, so you always know WHY you call a tool and WHAT should " +
      "change afterwards. Effects are a CLOSED vocabulary (see the schema): pick a metric and fill its " +
      "parameters — never invent metrics. The server tracks which steps actually execute (matched from your " +
      "tool calls) and, if the goal check fails at the end, reports per step: which steps never ran and which " +
      "predicted effects were NOT observed against the measured Set — use that to fix the right step instead " +
      "of repeating calls blindly. Skip set_plan for single-call tweaks. Re-declaring replaces the plan.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Ordered plan steps (max 12). Keep descriptions short and musical.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Optional stable id (auto-assigned step-N when omitted)" },
              description: {
                type: "string",
                description: "One short sentence of intent, e.g. \"Add open-hat pattern to the drop\"",
              },
              tool: {
                type: "string",
                description: "The tool expected to carry out this step (must be a real tool name)",
              },
              args: {
                type: "object",
                description: "Optional sketch of the intended call arguments — display only, never validated",
              },
              expectedEffects: {
                type: "array",
                description: "What this step should measurably change (max 4 per step) — checked against the Set at the end",
                items: {
                  type: "object",
                  properties: {
                    metric: {
                      type: "string",
                      enum: [...EFFECT_METRICS],
                      description:
                        "section_energy: a section's note density (notes/bar) moves vs baseline — needs section + direction. " +
                        "section_tracks: a section's active-track count moves — needs section + direction. " +
                        "role_audible: a role (kick|bass|drums|chords|pad|lead|…, or group low_end) is audible afterwards — " +
                        "needs role, optional section (whole song when omitted), NO direction. " +
                        "track_notes: a track's audible note count moves — needs track (name) + direction. " +
                        "track_count / tempo: total tracks / song tempo moves — need direction only. " +
                        "track_crest: the track's clip SOURCE FILE crest factor (dB) moves — needs track + direction. " +
                        "track_band_energy: the track's clip SOURCE FILE energy fraction in `band` (sub|bass|lowMid|mid|highMid|high) " +
                        "moves — needs track + direction + band. The audio metrics judge the source file: mixer/warp/device edits " +
                        "never move them — only replacing the sample does.",
                    },
                    direction: {
                      type: "string",
                      enum: ["increase", "decrease"],
                      description: "Required for every metric except role_audible",
                    },
                    section: { type: "string", description: "Section cue name or \"bars N-M\" from analyze_song" },
                    track: { type: "string", description: "track_notes / track_crest / track_band_energy: track NAME (indices drift, names don't)" },
                    role: { type: "string", description: "role_audible: role name, or group low_end" },
                    band: { type: "string", description: "track_band_energy: sub | bass | lowMid | mid | highMid | high" },
                  },
                  required: ["metric"],
                },
              },
            },
            required: ["description"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "arrange_song",
    description:
      "Build or rebuild the arrangement in ONE call from a placement plan. Each placement copies a source clip — an arrangement clip via clip_index, or a session clip via scene_index — onto ITS OWN track at start_bar for length_bars. Looping sources tile their loop region to fill the length; one-shots play once and leave silence. The whole plan is validated BEFORE anything changes (bad references and same-track overlaps abort with zero writes). Once execution starts, SDK operations commit step by step; if a later one fails, earlier completed changes remain and can be undone step by step in Live. MIDI clips are baked note-by-note (tiled/trimmed); audio clips reference the same file (warp markers, fades and automation are NOT carried over). Sources stay untouched. Use analyze_song's clip map for source coordinates. Optional clear_range_bars wipes ALL tracks' clips in that inclusive bar range first — only for rebuilds. dry_run validates and reports the resolved plan without touching the Set. Cannot move clips across tracks or delete individual clips.",
    input_schema: {
      type: "object",
      properties: {
        placements: {
          type: "array",
          description: "What to place where (max 128). Pass [] with clear_range_bars to only clear.",
          items: {
            type: "object",
            properties: {
              track_index: { type: "number", description: "Source/target track, 0-based" },
              track_name: { type: "string", description: TRACK_NAME_DESC },
              clip_index: {
                type: "number",
                description: "Source: arrangement clip index on that track (from analyze_song's clip map). Mutually exclusive with scene_index.",
              },
              scene_index: {
                type: "number",
                description: "Source: session slot index on that track. Mutually exclusive with clip_index.",
              },
              start_bar: { type: "number", description: "Target position, 1-based bar number" },
              length_bars: { type: "number", description: "How long the new clip plays, in bars (> 0)" },
              name: { type: "string", description: "New clip name (default: source clip's name)" },
            },
            required: ["start_bar", "length_bars"],
          },
        },
        clear_range_bars: {
          type: "array",
          items: { type: "number" },
          description: "[startBar, endBar] inclusive — clear ALL tracks' clips in this range before placing (partially overlapping clips are trimmed to the range edge). Only for rebuilds.",
        },
        dry_run: {
          type: "boolean",
          description: "Validate and return the resolved plan without changing the Set",
        },
      },
      required: ["placements"],
    },
  },
  {
    name: "update_memory",
    description:
      "Update the user's persistent artist memory — their musical identity, saved to memory.json and injected into every chat's system prompt. " +
      "Call ONLY when the user states a durable preference about their own style (\"I make melodic techno around 124\", \"remember I prefer 909 drums\") " +
      "— never for one-off choices that apply only to the current Set, and never speculatively. " +
      "Pass only the fields to change: omitted fields stay unchanged; strings/arrays REPLACE the previous value (pass \"\" or [] to clear a field; 0 clears bpmMin/bpmMax).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Artist / project name" },
        genres: { type: "array", items: { type: "string" }, description: "Genres the user produces, e.g. [\"melodic techno\", \"deep house\"]" },
        bpmMin: { type: "number", description: "Lower end of the usual BPM range (20–999); 0 to clear" },
        bpmMax: { type: "number", description: "Upper end of the BPM range (same as bpmMin for one fixed BPM); 0 to clear" },
        keys: { type: "array", items: { type: "string" }, description: "Preferred musical keys, e.g. [\"A minor\", \"F# minor\"]" },
        sound: { type: "array", items: { type: "string" }, description: "Sound/timbre preferences, e.g. [\"909 drums\", \"warm analog pads\", \"acid basslines\"]" },
        artists: { type: "array", items: { type: "string" }, description: "Reference artists whose style the user likes" },
        notes: { type: "string", description: "Free-form notes about the user's style, goals or workflow" },
      },
    },
  },
  {
    name: "set_tempo",
    description: "Set the song tempo in BPM (20–999).",
    input_schema: {
      type: "object",
      properties: { bpm: { type: "number", description: "Tempo in BPM" } },
      required: ["bpm"],
    },
  },
  {
    name: "create_midi_track",
    description: "Create a new MIDI track, optionally with a name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  { name: "duplicate_track", description: "Duplicate a Track immediately after it. The copy keeps Live's default name.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC } }, required: ["track_index"] } },
  {
    name: "delete_track",
    description: "Permanently remove one regular track from the Set. Call ONLY when the CURRENT user message explicitly asks to delete a track; broad cleanup wording is not authorization. Live Undo can restore it.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
      },
      required: ["track_index"],
    },
  },
  {
    name: "create_audio_track",
    description: "Create a new audio track, optionally with a name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "create_move_track",
    description:
      "Create a MIDI track for sequencing an Ableton Move hardware unit over USB-C (firmware ≥1.5, Standalone Mode). The SDK cannot set MIDI output routing — the returned message contains one-time manual routing steps that MUST be relayed to the user. Afterwards, write clips into this track with write_midi_clip / write_session_clip as usual.",
    input_schema: {
      type: "object",
      properties: {
        channel: {
          type: "number",
          description:
            "MIDI channel the Move track listens on (1–16, default 1). On Move, a track's MIDI In channel is set via Shift + track button; 'Auto' accepts all channels not explicitly assigned to other tracks.",
        },
        name: { type: "string", description: "Track name (default: 'Move Ch <channel>')" },
      },
    },
  },
  {
    name: "move_status",
    description:
      "Check the connection to an Ableton Move on the local network: reachability, pairing state and firmware version.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_pair",
    description:
      "Pair with an Ableton Move over WiFi. Without `code`: makes the Move display a 6-digit pairing code — ask the user to read it off the device screen. With `code`: completes pairing and remembers the token for future sessions.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-digit code shown on the Move's display" },
        host: { type: "string", description: "Hostname or IP (default: move.local)" },
      },
    },
  },
  {
    name: "move_list_sets",
    description: "List the Sets stored on the paired Ableton Move (id, name, modified date).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_list_files",
    description:
      "List folders and files in the Move's user storage (samples, recordings). Without `path`, lists the root folders.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path, e.g. \"Samples\" or \"Samples/Drums\"" },
      },
    },
  },
  {
    name: "move_upload_sample",
    description:
      "Upload a local audio file (WAV/AIFF/MP3/FLAC/OGG/M4A) to the paired Move — e.g. a file just created by generate_audio. Lands in the given folder on the device (default \"Samples\"), ready to load into a drum pad or melodic track.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the local audio file" },
        folder: { type: "string", description: "Target folder on the Move (default \"Samples\")" },
        overwrite: { type: "boolean", description: "Replace an existing file with the same name (default false)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "move_download_set",
    description:
      "Download a Set (.ablbundle) from the paired Move into the User Library's AIbleton folder.",
    input_schema: {
      type: "object",
      properties: {
        set_id: { type: "string", description: "Set id from move_list_sets" },
      },
      required: ["set_id"],
    },
  },
  {
    name: "move_analyze_set",
    description:
      "Download a Set from the paired Move and analyze it like analyze_song: key detection, per-track roles/note stats, muted content and issue flags — plus Move extras (per-track mixer levels, device chains, sample list with durations). The .ablbundle is kept in the User Library's AIbleton folder. Move has no arrangement view, so all clips are session clips.",
    input_schema: {
      type: "object",
      properties: {
        set_id: { type: "string", description: "Set id from move_list_sets" },
        focus: {
          type: "string",
          description: "Optional, same as analyze_song's focus: narrow the read to a track name, role, or issue code.",
        },
      },
      required: ["set_id"],
    },
  },
  {
    name: "rename_track",
    description: "Rename a track by its 0-based index (as listed by get_song_overview).",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC + " (its CURRENT name, before the rename)" },
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "set_track_state",
    description: "Mute, unmute, solo, unsolo, arm or disarm a track by its 0-based index.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        mute: { type: "boolean" },
        solo: { type: "boolean" },
        arm: { type: "boolean" },
      },
    },
  },
  {
    name: "insert_device",
    description:
      'Insert a built-in Live device at the end of a track\'s device chain. Audible immediately: "Operator", "Wavetable" (synths), "Impulse". EMPTY and silent until loaded: "Drum Rack" (use load_drum_kit instead), "Simpler" (use load_sample instead), "Sampler" (cannot load samples via API — never use, pick Simpler). Effects: "Reverb", "Auto Filter", "Compressor", "EQ Eight", "Delay". Third-party plugins are not supported.',
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number", description: "0-based track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_name: { type: "string" },
      },
      required: ["device_name"],
    },
  },
  {
    name: "replace_device",
    description:
      "Safely replace one explicitly named built-in Live device on the same track. The default first inserts the replacement at the source device's position, verifies both devices, then deletes only the named source. Do NOT use insert_device to replace an existing instrument: it appends to the chain. If this tool returns replacement_not_applied with source_preserved:true, tell the user the safe insertion failed and ask for an explicit new request allowing deletion first; only then call again with allow_delete_first:true. Third-party plug-ins are not supported.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        source_device_name: { type: "string", description: "Current exact name of the device to remove after replacement succeeds" },
        source_device_index: { type: "number", description: "Optional 0-based source device index; source_device_name is preferred" },
        replacement_device_name: { type: "string", description: "Built-in Live device to insert, e.g. Analog or Wavetable" },
        allow_delete_first: {
          type: "boolean",
          description: "DANGEROUS fallback. Set true only after safe insertion failed AND the current user message explicitly authorizes deleting the named source before insertion. If insertion then fails, the user must use Live Undo.",
        },
      },
      required: ["track_index", "source_device_name", "replacement_device_name"],
    },
  },
  {
    name: "delete_device",
    description: "Remove one built-in device from a regular track. Call ONLY when the CURRENT user message explicitly asks to delete a device, or explicitly replaces/swaps a named device or instrument with another sound source. In a replacement, delete only the named source device. Live Undo can restore it.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number", description: "0-based device index on that track" },
        device_name: { type: "string", description: "Device name (alternative to device_index)" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "get_device_parameters",
    description:
      'List the parameters of a device on a track (works for Operator, Auto Filter, and any built-in device): name, current value, min/max, and option lists for enum parameters. device_index is the 0-based position in the track\'s device chain (see get_song_overview). Use "filter" to only return parameters whose name contains a string, e.g. "freq" or "lfo" — recommended for big devices like Operator.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number", description: "0-based device index on the track" },
        device_name: { type: "string", description: 'Device name, e.g. "Operator" (alternative to device_index)' },
        filter: { type: "string", description: "Optional case-insensitive name filter" },
      },
    },
  },
  {
    name: "set_device_parameter",
    description:
      'Set one parameter of a device (Operator, Auto Filter, …). "parameter" accepts an exact name, a partial name (e.g. "Frequency" or "freq"), or a numeric index from get_device_parameters. "value" is a number in the device\'s own units (Hz, dB, semitones, 0–1 for macros…) — it is clamped to the parameter\'s range. For enum parameters (isQuantized with items), pass the option name as a string instead. Pass "default" as the value to reset the parameter to its factory default.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number" },
        device_name: { type: "string", description: 'Device name (alternative to device_index)' },
        parameter: {
          type: "string",
          description: 'Parameter name (fuzzy ok, e.g. "freq") or its numeric index as a string',
        },
        value: {
          type: "string",
          description: 'A number as a string (e.g. "800") or, for enum parameters, the option name',
        },
      },
      required: ["parameter", "value"],
    },
  },
  {
    name: "set_device_parameters",
    description:
      'Set MULTIPLE parameters of one device in a single call — strongly preferred over repeated set_device_parameter for sound design (one call instead of many). Each item follows the same rules as set_device_parameter: "parameter" is an exact/partial name or numeric index, "value" a number as a string, an enum option name, or "default" to reset that parameter to its factory default (mix resets and sets freely). Sets run in parallel; per-parameter failures are reported without aborting the rest.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number" },
        device_name: { type: "string", description: 'Device name (alternative to device_index)' },
        params: {
          type: "array",
          description: "Up to 24 {parameter, value} pairs",
          items: {
            type: "object",
            properties: {
              parameter: { type: "string" },
              value: { type: "string" },
            },
            required: ["parameter", "value"],
          },
        },
      },
      required: ["params"],
    },
  },
  {
    name: "load_drum_kit",
    description:
      'Load a factory drum kit into a track: builds a Drum Rack with Simpler pads loaded with real samples (from the Drum Essentials pack). Use it for ANY drum style — pass the style in `kit` ("808", "909", "707", "606", "DMX", …); omit it for the default 808 kit. Reuses an existing EMPTY Drum Rack on the track if present, otherwise creates one. Pad note map (use these pitches in write_midi_clip): 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 51=Ride; the 808 kit also has 75=Clave. The returned pad list is authoritative — write MIDI only with the notes it contains. THIS is the way to make drums audible — ALWAYS use it for drums, never build drum parts track-by-track with load_sample.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        kit: {
          type: "string",
          description:
            'Drum style keyword, e.g. "808", "909", "707", "606", "DMX". Omit for 808. Unknown keywords are matched against sample file names in the Drum Essentials pack.',
        },
      },
    },
  },
  { name: "list_drum_rack_pads", description: "List Drum Rack pads on a track: receiving MIDI note, chain devices, volume, pan and sends.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC } }, required: ["track_index"] } },
  { name: "get_drum_pad_mixer", description: "Read one Drum Rack pad chain's devices, volume, pan and sends. rack_index defaults to 0.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number", description: "MIDI receiving note, e.g. 36 kick, 38 snare" } }, required: ["track_index", "pad_note"] } },
  { name: "set_drum_pad_mixer", description: "Set one Drum Rack pad chain's volume, pan and/or sends. Values are clamped to Live's parameter range.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, volume: { type: "number" }, pan: { type: "number" }, sends: { type: "array", items: { type: "object" } } }, required: ["track_index", "pad_note"] } },
  { name: "insert_drum_pad_device", description: "Append a built-in Live device to one Drum Rack pad's chain. Third-party plug-ins are unsupported.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_name: { type: "string" } }, required: ["track_index", "pad_note", "device_name"] } },
  { name: "duplicate_drum_pad_device", description: "Duplicate a device on one Drum Rack pad chain immediately after itself.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_index: { type: "number" }, device_name: { type: "string" } }, required: ["track_index", "pad_note"] } },
  { name: "delete_drum_pad_device", description: "Remove one device from a Drum Rack pad chain. Call ONLY when the CURRENT user message explicitly asks to delete a device; Live Undo can restore it.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_index: { type: "number" }, device_name: { type: "string" } }, required: ["track_index", "pad_note"] } },
  { name: "get_drum_pad_device_parameters", description: "List parameters for one device inside a Drum Rack pad chain: values, min/max, defaults, and enum choices. Use filter for large devices. This is read-only.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_index: { type: "number" }, device_name: { type: "string" }, filter: { type: "string", description: "Optional case-insensitive parameter-name filter" } }, required: ["track_index", "pad_note"] } },
  { name: "set_drum_pad_device_parameter", description: "Set one device parameter inside a Drum Rack pad chain. parameter accepts a name, unique partial name, or numeric index; value accepts a number, enum name, or default.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_index: { type: "number" }, device_name: { type: "string" }, parameter: { type: "string" }, value: { type: "string" } }, required: ["track_index", "pad_note", "parameter", "value"] } },
  { name: "set_drum_pad_device_parameters", description: "Set up to 24 parameters on one Drum Rack pad-chain device. Each item is independent: valid items apply even when another item fails.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, device_index: { type: "number" }, device_name: { type: "string" }, params: { type: "array", items: { type: "object", properties: { parameter: { type: "string" }, value: { type: "string" } }, required: ["parameter", "value"] } } }, required: ["track_index", "pad_note", "params"] } },
  { name: "get_drum_pad_sample", description: "List every Simpler and its loaded sample on one Drum Rack pad. This is read-only.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number", description: "MIDI receiving note, e.g. 36 kick, 38 snare" } }, required: ["track_index", "pad_note"] } },
  { name: "replace_drum_pad_sample", description: "Replace a Drum Rack pad Simpler's sample with a local audio file. The file is copied into the Live Project first. Select a Simpler by device_index/device_name; omit both to use the first one. If the pad has no Simpler, one is inserted at chain index 0.", input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC }, rack_index: { type: "number" }, rack_name: { type: "string" }, pad_note: { type: "number" }, file_path: { type: "string", description: "Full local source path, preferably returned by search_samples" }, device_index: { type: "number", description: "Optional Simpler index in this pad's device chain" }, device_name: { type: "string", description: "Optional Simpler name (alternative to device_index)" } }, required: ["track_index", "pad_note", "file_path"] } },
  {
    name: "search_samples",
    description:
      'Search local sample libraries — Splice folder (if the Splice app is installed and synced), Ableton User Library, Factory Packs, and Live\'s Core Library. Understands musical metadata in file names: BPM ("124 bpm" or a bare "124"), key ("Am", "F#", "Bb major"), instruments (kick, pad, 808, vocal…) and vibe words — synonyms are built in, so "dark" also matches rumble/industrial/sub, "warm" → analog/tape/mellow, "punchy" → punch/tight. All keywords must match; results are RANKED — exact BPM/key matches first, then relative major/minor, then relevance. Returns up to 30 full file paths plus how the query was parsed. Queries like "dark pad 124 bpm am", "808 kick", "tech house loop". Note: Splice\'s online catalog cannot be browsed — only locally synced files are searchable.',
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for CURRENT information — software versions and release notes, prices, tutorials, news, facts you don't know. Free and keyless. Returns up to 8 results with title/URL/snippet. For LOCAL sample files on the user's disk use search_samples instead.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Specific keywords, e.g. "Ableton Live 12.3 release notes"' },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its readable text (static HTML only — JS-rendered pages may return little). Use after web_search to read the most promising result in full, or on a URL the user pasted.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL" } },
      required: ["url"],
    },
  },
  {
    name: "import_audio_clip",
    description:
      "Import an audio file (from search_samples) into an AUDIO track — into the arrangement at a beat position (default), or into a Session View slot when scene_index is given (for live-triggered loops; the slot must be empty). The file is copied into the Live project first, so it stays managed by Live.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        file_path: { type: "string", description: "Full path from search_samples" },
        scene_index: { type: "number", description: "Optional Session scene — drops the clip into that empty slot instead of the arrangement" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0); ignored when scene_index is set" },
        duration_beats: { type: "number", description: "Optional clip length in beats (arrangement only)" },
        warped: { type: "boolean", description: "Enable warping (default: Live's auto-warp setting)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "load_sample",
    description:
      "Load an audio file into a Simpler on a track (reuses an existing Simpler, otherwise inserts one). For pitched/melodic one-shots: bass hits, vocal chops, stabs. For drums use load_drum_kit instead.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        file_path: { type: "string", description: "Full path from search_samples" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_simpler_sample",
    description: "Read the sample currently loaded in a Simpler on a track. If device_index and device_name are omitted, reads the first Simpler. This is read-only.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        device_index: { type: "number", description: "Optional Simpler index in the track device chain" },
        device_name: { type: "string", description: "Optional Simpler name (alternative to device_index)" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "list_take_lanes",
    description:
      "List a track's non-destructive Take Lanes and their candidate arrangement clips. A lane holding a candidate is not evidence that Live is currently auditioning it.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
      },
      required: ["track_index"],
    },
  },
  {
    name: "create_take_lane",
    description:
      "Append a named Take Lane to a track for a non-destructive candidate version. Use before write_take_midi_clip or import_take_audio_clip; never overwrite the main arrangement clip when the user asks for alternatives.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        name: { type: "string", description: "Candidate label, e.g. 'Bass Alternative A'" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "write_take_midi_clip",
    description:
      "Create a MIDI candidate clip in an existing Take Lane without touching arrangement clips. Same notes, swing and snap_to_grid format as write_midi_clip. Use list_take_lanes first to obtain take_lane_index.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based MIDI-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        take_lane_index: { type: "number", description: "0-based Take Lane index from list_take_lanes" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0)" },
        length_beats: { type: "number", description: "Clip length in beats (default 16)" },
        name: { type: "string", description: "Candidate clip name" },
        swing: { type: "number", description: "0–100 baked MIDI swing, same as write_midi_clip" },
        snap_to_grid: { type: "boolean", description: "Snap note starts to Live's current grid before swing" },
        notes: { type: "array", items: { type: "object", properties: MIDI_NOTE_PROPERTIES, required: ["pitch", "start"] }, description: "Same note format as write_midi_clip" },
      },
      required: ["track_index", "take_lane_index", "notes"],
    },
  },
  {
    name: "import_take_audio_clip",
    description:
      "Import an audio candidate into an existing Take Lane on an Audio Track without touching arrangement clips. The source is copied into the Live project first. Use list_take_lanes first to obtain take_lane_index.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based Audio-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        take_lane_index: { type: "number", description: "0-based Take Lane index from list_take_lanes" },
        file_path: { type: "string", description: "Absolute local audio-file path" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0)" },
        duration_beats: { type: "number", description: "Optional candidate clip length in beats" },
        warped: { type: "boolean", description: "Enable warping (default: Live's auto-warp setting)" },
      },
      required: ["track_index", "take_lane_index", "file_path"],
    },
  },
  {
    name: "get_audio_clip_warp",
    description:
      "Read an existing Audio Clip's Warp state, algorithm and read-only warp markers. Target exactly one source: clip_index for an arrangement clip, or scene_index for a Session slot.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number", description: "0-based arrangement Audio Clip index" },
        scene_index: { type: "number", description: "0-based Session slot index" },
      },
      required: ["track_index"],
    },
  },
  {
    name: "set_audio_clip_warp",
    description:
      "Change an existing Audio Clip's Warp on/off state and/or algorithm. Target exactly one source: clip_index for arrangement, or scene_index for Session. Setting warp_mode automatically enables Warping. Marker editing is not supported by the SDK.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number", description: "0-based arrangement Audio Clip index" },
        scene_index: { type: "number", description: "0-based Session slot index" },
        warped: { type: "boolean", description: "Enable or disable Warping" },
        warp_mode: { type: "string", enum: ["beats", "tones", "texture", "repitch", "complex", "complex_pro"] },
      },
      required: ["track_index"],
    },
  },
  {
    name: "generate_audio",
    description:
      "Generate NEW audio with an AI music model (Stable Audio / ElevenLabs / MiniMax — whichever is configured in Settings) and save it into the User Library's 'AIbleton' folder. Costs API credits and takes ~10–60 s. Pass importTo to place the result onto an audio track's arrangement (or a Session View slot via importTo.scene_index) in the same atomic call (preferred for loops/stems); without it, follow up with import_audio_clip (arrangement or Session) or load_sample (one-shots into a Simpler). Every generation is recorded in the generation registry (generation_id in the result) so gen_* goal criteria can judge the artifact.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "English, specific: genre, BPM, key, instrumentation, mood. Add 'seamless loop' for loops.",
        },
        duration_seconds: { type: "number", description: "1–190 (default 8); use 4–16 for loops" },
        instrumental: {
          type: "boolean",
          description: "Guarantee no vocals (ElevenLabs / MiniMax; Stable Audio is always instrumental)",
        },
        lyrics: {
          type: "string",
          description: "Vocal lyrics — MiniMax only; omit for instrumentals",
        },
        importTo: {
          type: "object",
          description:
            "Optional: import the generated file straight onto an audio track in the same call (one atomic generate→import, no separate import_audio_clip needed). Targets the arrangement by default; pass scene_index to drop it into that empty Session View slot instead. Omit importTo entirely to only save the file.",
          properties: {
            track_index: { type: "number", description: "0-based audio track index" },
            track_name: { type: "string", description: TRACK_NAME_DESC },
            scene_index: { type: "number", description: "Optional Session scene — drops the clip into that empty slot instead of the arrangement" },
            start_beat: { type: "number", description: "Arrangement position (default 0); ignored when scene_index is set" },
            duration_beats: { type: "number", description: "Clip length in beats (default: file's natural length; arrangement only)" },
            warped: { type: "boolean", description: "Warp the clip to the Set tempo (default: Live's default)" },
          },
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "write_midi_clip",
    description:
      "Create a MIDI clip in a track's arrangement and fill it with notes. Times are in beats (4/4: one bar = 4 beats, so 4 bars = 16 beats). pitch is a MIDI note number (0–127); for an Impulse drum kit use pitches 48–60 (48=kick-ish, 50=snare-ish, 54=closed hat-ish, 58=open hat-ish).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        start_beat: { type: "number", description: "Clip position in the arrangement, in beats (default 0)" },
        length_beats: { type: "number", description: "Clip length in beats (default 16 = 4 bars)" },
        name: { type: "string" },
        swing: {
          type: "number",
          description:
            "Swing amount 0–100, baked into the note timing (delays + softens offbeat 16th notes). 0=straight, 30=light MPC-style, 60=pronounced, 100=full triplet swing. The SDK cannot assign Live groove files, so swing must be baked in here.",
        },
        snap_to_grid: {
          type: "boolean",
          description:
            "Snap note starts to the song's CURRENT arrangement grid (default false). Use ONLY when the user asks to align notes to the grid, AND the grid is at least as fine as the note spacing (e.g. 8th-note pattern with a 1/8 or 1/16 grid) — snapping to a COARSER grid than the note spacing collapses the pattern onto grid lines and destroys it. Applied BEFORE swing, so swing still works. Leave false for triplet patterns on a straight grid and for humanized/off-grid timing.",
        },
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: MIDI_NOTE_PROPERTIES,
            required: ["pitch", "start"],
          },
        },
      },
      required: ["notes"],
    },
  },
  {
    name: "write_session_clip",
    description:
      "Create a looping MIDI clip in a Session View slot (track_index × scene_index) and fill it with notes. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        scene_index: { type: "number" },
        length_beats: { type: "number", description: "Clip length in beats (default 16)" },
        name: { type: "string" },
        swing: {
          type: "number",
          description: "Swing amount 0–100, baked into note timing (see write_midi_clip)",
        },
        snap_to_grid: {
          type: "boolean",
          description: "Snap note starts to the song's current grid, default false (see write_midi_clip — coarse grids destroy fine patterns)",
        },
        notes: { type: "array", items: { type: "object", properties: MIDI_NOTE_PROPERTIES, required: ["pitch", "start"] } },
      },
      required: ["scene_index", "notes"],
    },
  },
  {
    name: "get_clip_notes",
    description: "Read the notes of an arrangement MIDI clip (track_index + clip_index from get_song_overview order).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number" },
      },
      required: ["clip_index"],
    },
  },
  {
    name: "delete_arrangement_clip",
    description: "Delete one Arrangement View clip from a regular track. Call ONLY when the CURRENT user message explicitly asks to delete an arrangement clip; Live Undo can restore it.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number", description: "0-based arrangement-clip index on that track" },
      },
      required: ["track_index", "clip_index"],
    },
  },
  {
    name: "delete_session_clip",
    description: "Delete the clip in one Session View slot. Call ONLY when the CURRENT user message explicitly asks to delete a Session clip; Live Undo can restore it.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number", description: "0-based regular-track index" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        scene_index: { type: "number", description: "0-based Session scene / slot index" },
      },
      required: ["track_index", "scene_index"],
    },
  },
  {
    name: "set_clip_notes",
    description: "Replace all notes of an existing arrangement MIDI clip. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number" },
        snap_to_grid: {
          type: "boolean",
          description: "Snap note starts to the song's current grid, default false (see write_midi_clip — coarse grids destroy fine patterns)",
        },
        notes: { type: "array", items: { type: "object", properties: MIDI_NOTE_PROPERTIES, required: ["pitch", "start"] } },
      },
      required: ["clip_index", "notes"],
    },
  },
  {
    name: "set_track_mixer",
    description:
      "Set a track's mixer settings: volume, pan, and/or sends to Return Tracks. Send index 0 is Return Track 0 / Send A, index 1 is Send B.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        volume: { type: "number" },
        pan: { type: "number" },
        sends: { type: "array", maxItems: 12, items: { type: "object", properties: { index: { type: "number" }, value: { type: "number" } }, required: ["index", "value"] } },
      },
    },
  },
  {
    name: "get_track_mixer",
    description: "Read a track's current volume, pan, and sends. Send index 0 maps to Return Track 0 / Send A. Call before changing mixer or send levels when current values matter.",
    input_schema: { type: "object", properties: { track_index: { type: "number" }, track_name: { type: "string", description: TRACK_NAME_DESC } }, required: ["track_index"] },
  },
  { name: "get_return_track_mixer", description: "Read a Return Track mixer by zero-based return_index.", input_schema: { type: "object", properties: { return_index: { type: "number" } }, required: ["return_index"] } },
  { name: "set_return_track_mixer", description: "Set a Return Track's volume and/or pan by zero-based return_index.", input_schema: { type: "object", properties: { return_index: { type: "number" }, volume: { type: "number" }, pan: { type: "number" } }, required: ["return_index"] } },
  { name: "get_master_chain", description: "Read Master mixer values and its device chain. Always inspect before proposing a Master change.", input_schema: { type: "object", properties: {} } },
  { name: "get_master_device_parameters", description: "Read parameters of an existing Master device by device_index or device_name.", input_schema: { type: "object", properties: { device_index: { type: "number" }, device_name: { type: "string" } } } },
  { name: "set_master_device_parameter", description: "Set one existing Master device parameter. Call only when the CURRENT user explicitly asks to adjust Master/mastering.", input_schema: { type: "object", properties: { device_index: { type: "number" }, device_name: { type: "string" }, parameter: { type: "string" }, value: { type: "string" } }, required: ["parameter", "value"] } },
  {
    name: "create_scene",
    description: "Create a new scene, optionally named. Appended at the end unless index is given.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        index: { type: "number", description: "0-based insert position, -1 appends" },
      },
    },
  },
  { name: "duplicate_scene", description: "Duplicate a Scene immediately after it. The copy keeps Live's default name.", input_schema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] } },
  {
    name: "delete_scene",
    description: "Delete one Session View scene. Call ONLY when the CURRENT user message explicitly asks to delete a scene; Live Undo can restore it.",
    input_schema: {
      type: "object",
      properties: { scene_index: { type: "number", description: "0-based scene index" } },
      required: ["scene_index"],
    },
  },
  { name: "create_cue_point", description: "Create a named Cue Point at a 1-based arrangement bar.", input_schema: { type: "object", properties: { bar: { type: "number" }, name: { type: "string" } }, required: ["bar", "name"] } },
  { name: "rename_cue_point", description: "Rename a Cue Point by its current zero-based index.", input_schema: { type: "object", properties: { index: { type: "number" }, name: { type: "string" } }, required: ["index", "name"] } },
  { name: "delete_cue_point", description: "Delete a Cue Point by its current zero-based index.", input_schema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] } },
  {
    name: "rename_scene",
    description: "Rename a scene by its 0-based index.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "number" },
        name: { type: "string" },
      },
      required: ["index", "name"],
    },
  },
];

/** Web tools leave the tools list entirely when the toggle is off, so the
 * model can't call them (and weak relay models can't imitate them). */
export function activeTools(): typeof TOOLS {
  if (toolState.webSettings.enabled) return TOOLS;
  return TOOLS.filter((t) => t.name !== "web_search" && t.name !== "web_fetch");
}
