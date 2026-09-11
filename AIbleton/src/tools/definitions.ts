import { CRITERION_KINDS, GOAL_TYPES } from "../goal/types.js";
import { EFFECT_METRICS } from "../plan/types.js";

// ---------- Claude tool definitions ----------

/** Shared description for the optional track_name param on every track tool. */
export const TRACK_NAME_DESC =
  "Track name as listed by get_song_overview. Always pass it together with the index: " +
  "the pair is verified and the track is re-resolved by name if the index has shifted since.";

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
      "Build or rebuild the arrangement in ONE call from a placement plan. Each placement copies a source clip — an arrangement clip via clip_index, or a session clip via scene_index — onto ITS OWN track at start_bar for length_bars. Looping sources tile their loop region to fill the length; one-shots play once and leave silence. The whole plan is validated BEFORE anything changes (bad references and same-track overlaps abort with zero writes) and executed as a single undo step. MIDI clips are baked note-by-note (tiled/trimmed); audio clips reference the same file (warp markers, fades and automation are NOT carried over). Sources stay untouched. Use analyze_song's clip map for source coordinates. Optional clear_range_bars wipes ALL tracks' clips in that inclusive bar range first — only for rebuilds. dry_run validates and reports the resolved plan without touching the Set. Cannot move clips across tracks or delete individual clips.",
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
      'Set one parameter of a device (Operator, Auto Filter, …). "parameter" accepts an exact name, a partial name (e.g. "Frequency" or "freq"), or a numeric index from get_device_parameters. "value" is a number in the device\'s own units (Hz, dB, semitones, 0–1 for macros…) — it is clamped to the parameter\'s range. For enum parameters (isQuantized with items), pass the option name as a string instead.',
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
    name: "load_drum_kit",
    description:
      'Load Ableton\'s factory 808 drum kit into a track: builds a Drum Rack with Simpler pads loaded with real 808 samples (from the Drum Essentials pack). Reuses an existing EMPTY Drum Rack on the track if present, otherwise creates one. Pad note map (use these pitches in write_midi_clip): 36=Kick, 37=Rim, 38=Snare, 39=Clap, 41=Tom Low, 42=Hihat Closed, 43=Tom Mid, 45=Tom Hi, 46=Hihat Open, 49=Cymbal, 75=Clave. THIS is the way to make drums audible — prefer it over insert_device for drums.',
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
      },
    },
  },
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
      "Import an audio file (from search_samples) into an AUDIO track's arrangement at a beat position — for loops, stems, one-shots. The file is copied into the Live project first, so it stays managed by Live.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        file_path: { type: "string", description: "Full path from search_samples" },
        start_beat: { type: "number", description: "Arrangement position in beats (default 0)" },
        duration_beats: { type: "number", description: "Optional clip length in beats" },
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
    name: "generate_audio",
    description:
      "Generate NEW audio with an AI music model (Stable Audio / ElevenLabs / MiniMax — whichever is configured in Settings) and save it into the User Library's 'AIbleton' folder. Costs API credits and takes ~10–60 s. Pass importTo to place the result onto an audio track's arrangement in the same atomic call (preferred for loops/stems); without it, follow up with import_audio_clip (arrangement) or load_sample (one-shots into a Simpler). Every generation is recorded in the generation registry (generation_id in the result) so gen_* goal criteria can judge the artifact.",
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
            "Optional: import the generated file straight onto an audio track's arrangement in the same call (one atomic generate→import, no separate import_audio_clip needed). Omit to only save the file.",
          properties: {
            track_index: { type: "number", description: "0-based audio track index" },
            track_name: { type: "string", description: TRACK_NAME_DESC },
            start_beat: { type: "number", description: "Arrangement position (default 0)" },
            duration_beats: { type: "number", description: "Clip length in beats (default: file's natural length)" },
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
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pitch: { type: "number" },
              start: { type: "number", description: "Note start in beats, relative to clip start" },
              duration: { type: "number", description: "Note length in beats (default 0.25)" },
              velocity: { type: "number", description: "1–127 (default 100)" },
            },
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
        notes: { type: "array", items: { type: "object" } },
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
    name: "set_clip_notes",
    description: "Replace all notes of an existing arrangement MIDI clip. Same note format as write_midi_clip.",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        clip_index: { type: "number" },
        notes: { type: "array", items: { type: "object" } },
      },
      required: ["clip_index", "notes"],
    },
  },
  {
    name: "set_track_mixer",
    description:
      "Set a track's mixer settings: volume (0–1, where 0.85 ≈ 0 dB) and/or pan (-1 = full left, 0 = center, 1 = full right).",
    input_schema: {
      type: "object",
      properties: {
        track_index: { type: "number" },
        track_name: { type: "string", description: TRACK_NAME_DESC },
        volume: { type: "number" },
        pan: { type: "number" },
      },
    },
  },
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
