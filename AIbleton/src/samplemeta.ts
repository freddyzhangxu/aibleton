/**
 * Filename-metadata sample search — no audio analysis, just conventions.
 * Sample packs almost always encode BPM/key/instrument in file and folder
 * names ("DSOH_124_bpm_Amin_dark_pad_loop.wav"). This module parses that
 * metadata at index time, expands query terms through a synonym map
 * ("dark" → rumble/industrial/sub…) and ranks results by relevance
 * (exact BPM/key first). Pure string processing — sandbox-safe.
 */

export interface SampleEntry {
  /** Original full path (returned to the model). */
  p: string;
  /** Matching surface: lowercased, separators → space, whole path. */
  n: string;
  /** Normalized filename stem only (match bonus + preferred meta source). */
  f: string;
  bpm?: number;
  /** Key root semitone 0–11 (C=0), undefined = no key parsed. */
  ks?: number;
  /** true = minor, false/undefined = major. */
  km?: boolean;
}

export const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

// ---------------------------------------------------------------- BPM ----

/** Gear model numbers that fall in BPM range — "SH-101", "JUNO-106" are not tempos. */
const GEAR_NUMBERS = new Set([101, 106]);

export function parseBpm(normalizedText: string): number | undefined {
  const explicit =
    /(\d{2,3})\s*bpm(?: |$)/.exec(normalizedText) ?? /(?:^| )bpm (\d{2,3})/.exec(normalizedText);
  if (explicit) {
    const n = Number(explicit[1]);
    if (n >= 40 && n <= 240) return n;
  }
  for (const tok of normalizedText.split(" ")) {
    if (!/^\d{2,3}$/.test(tok)) continue;
    const n = Number(tok);
    if (n >= 70 && n <= 180 && !GEAR_NUMBERS.has(n)) return n;
  }
  return undefined;
}

// ---------------------------------------------------------------- key ----

const SEMITONES: Record<string, number> = {
  c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5, "f#": 6, gb: 6,
  g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11,
};

/** Compact matches that mean something else: FM synthesis, General MIDI. */
const KEY_BLACKLIST = new Set(["fm", "gm"]);

export interface ParsedKey {
  semitone: number;
  minor: boolean;
  /** Canonical display, e.g. "Am", "F#", "Bb". */
  label: string;
  /** Match span in the searched string (for query-term removal). */
  start: number;
  end: number;
}

/**
 * "Am", "Amin", "C#m", "Bbmin", "Fmaj", "A minor", "F# Major" (any case).
 * Boundaries are custom lookarounds, NOT \b: pack names separate tokens with
 * underscores, and \w includes "_" — "…_Amin_…" has no \b around it.
 */
const KEY_MODE_RE = /(?<![A-Za-z0-9])([A-Ga-g])(#|b|♯|♭)?\s*(major|minor|maj|min|m)(?![A-Za-z0-9])/g;
/**
 * Bare standalone UPPERCASE note: "F#", "Bb", "C". Lowercase excluded ("a"/"e" words stay safe).
 * The trailing lookahead also kills note-name false positives like "C2"/"A3".
 */
const KEY_BARE_RE = /(?<![A-Za-z0-9])([A-G])(#|b|♯|♭)?(?![A-Za-z0-9])/g;

function toKey(letter: string, acc: string | undefined, mode: string | undefined, start: number, end: number): ParsedKey | undefined {
  const accNorm = acc === "♯" ? "#" : acc === "♭" ? "b" : acc ?? "";
  const root = SEMITONES[(letter.toLowerCase() + accNorm) as keyof typeof SEMITONES];
  if (root === undefined) return undefined;
  const minor = !!mode && /^(m|min|minor)$/i.test(mode) && !/^maj/i.test(mode);
  const compact = (letter + accNorm + (mode ?? "")).toLowerCase();
  if (KEY_BLACKLIST.has(compact)) return undefined;
  return {
    semitone: root,
    minor,
    label: letter.toUpperCase() + accNorm + (minor ? "m" : ""),
    start,
    end,
  };
}

export function parseKey(text: string): ParsedKey | undefined {
  KEY_MODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_MODE_RE.exec(text))) {
    const k = toKey(m[1], m[2], m[3], m.index, m.index + m[0].length);
    if (k) return k;
  }
  KEY_BARE_RE.lastIndex = 0;
  while ((m = KEY_BARE_RE.exec(text))) {
    const k = toKey(m[1], m[2], undefined, m.index, m.index + m[0].length);
    if (k) return k;
  }
  return undefined;
}

// ----------------------------------------------------------- synonyms ----

/**
 * Query-side expansion: a term matches if the term itself OR any synonym
 * appears in the path. Descriptors map to the words pack authors actually
 * write in file names; instrument aliases go both ways.
 */
const SYNONYMS: Record<string, string[]> = {
  // vibe / descriptors
  dark: ["rumble", "industrial", "sub", "distorted", "grimy", "moody", "noir"],
  bright: ["sparkle", "crisp", "shiny", "airy", "shimmer", "glass"],
  warm: ["analog", "tape", "vinyl", "mellow", "smooth", "soft"],
  aggressive: ["distorted", "distortion", "hard", "harsh", "dirty", "gritty", "drive"],
  deep: ["sub", "low", "rumble", "dark"],
  punchy: ["punch", "tight", "snap", "transient", "smack"],
  fat: ["thick", "phat", "wide", "saturated", "beefy"],
  ambient: ["atmosphere", "soundscape", "drone", "texture", "pad"],
  ethereal: ["airy", "dreamy", "celestial", "shimmer"],
  dreamy: ["dream", "ethereal", "lush", "haze"],
  lofi: ["lo-fi", "dusty", "tape", "vinyl", "gritty"],
  epic: ["cinematic", "trailer", "orchestral", "massive"],
  cinematic: ["film", "score", "epic", "trailer"],
  funky: ["funk", "groove", "groovy", "disco"],
  groovy: ["groove", "funky", "swing"],
  hypnotic: ["trance", "arp", "repetitive", "mesmerizing"],
  tribal: ["ethnic", "world", "afro", "ritual"],
  glitchy: ["glitch", "stutter", "granular", "broken"],
  dirty: ["gritty", "distorted", "filthy", "grime"],
  clean: ["dry", "pristine", "pure"],
  heavy: ["hard", "massive", "big"],
  uplifting: ["euphoric", "anthem", "happy"],
  sad: ["melancholy", "emotional", "dark"],
  emotional: ["melancholy", "sad", "cinematic"],
  spooky: ["horror", "eerie", "creepy", "haunted"],
  spacey: ["space", "cosmic", "wide", "reverb"],
  retro: ["vintage", "80s", "synthwave", "oldschool"],
  vintage: ["retro", "tape", "vinyl", "analog", "classic"],
  // instrument aliases
  kick: ["bassdrum", "bass drum", "bd"],
  snare: ["snr", "sd"],
  hihat: ["hi hat", "hi-hat", "hh", "hat"],
  hat: ["hihat", "hi hat", "hi-hat"],
  cymbal: ["crash", "ride"],
  vocal: ["vox", "voice", "acapella"],
  vox: ["vocal", "voice"],
  bass: ["sub", "reese", "wobble"],
  sub: ["808", "bass"],
  synth: ["synthesizer"],
  keys: ["piano", "rhodes", "epiano", "e piano"],
  piano: ["keys", "grand"],
  strings: ["string", "orchestral", "violin", "cello"],
  pad: ["atmosphere", "drone"],
  fx: ["sfx", "effect", "riser", "impact", "sweep", "downlift"],
  riser: ["uplifter", "rise"],
  loop: ["loops"],
  oneshot: ["one shot", "one-shot", "hit", "shot"],
};

// ----------------------------------------------------------- matching ----

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex cache: short variants match token-strict (+optional plural "s"), long ones substring. */
const variantRes = new Map<string, RegExp>();

function variantMatches(normalizedText: string, variant: string): boolean {
  const v = variant.toLowerCase();
  let re = variantRes.get(v);
  if (!re) {
    re = v.length <= 3 ? new RegExp(`(?:^| )${escapeRe(v)}s?(?: |$)`) : new RegExp(escapeRe(v));
    variantRes.set(v, re);
  }
  return re.test(normalizedText);
}

// -------------------------------------------------------------- query ----

/** Article/preposition tokens stripped before key parsing so "a dark pad" ≠ key of A. */
const STOPWORDS_RE = /\b(a|an|the|in|on|with|for)\b/g;

export interface SampleQuery {
  terms: string[];
  bpm?: number;
  key?: ParsedKey;
}

export function parseSampleQuery(q: string): SampleQuery {
  // Key first, on the original string (case matters for bare "A" vs word "a").
  const noStop = q.replace(STOPWORDS_RE, " ");
  const key = parseKey(noStop);
  let rest = key ? noStop.slice(0, key.start) + " " + noStop.slice(key.end) : noStop;

  // BPM: explicit "124 bpm" wins; otherwise a bare 70–180 digit token.
  let bpm: number | undefined;
  const explicit = /(\d{2,3})\s*bpm\b/i.exec(rest) ?? /\bbpm\s*(\d{2,3})/i.exec(rest);
  if (explicit) {
    bpm = Number(explicit[1]);
    rest = rest.slice(0, explicit.index) + " " + rest.slice(explicit.index + explicit[0].length);
  } else {
    const norm = normalize(rest);
    const tokens = norm.split(" ");
    for (let i = 0; i < tokens.length; i++) {
      if (!/^\d{2,3}$/.test(tokens[i])) continue;
      const n = Number(tokens[i]);
      if (n >= 70 && n <= 180 && !GEAR_NUMBERS.has(n)) {
        bpm = n;
        tokens.splice(i, 1);
        rest = tokens.join(" ");
        break;
      }
    }
  }

  const terms = normalize(rest).split(" ").filter((t) => t.length > 0);
  return { terms, bpm, key };
}

// -------------------------------------------------------------- search ----

export interface SampleSearchResult {
  total: number;
  results: string[];
  /** How the query was understood — lets the model iterate when results disappoint. */
  parsed: { terms: string[]; bpm?: number; key?: string };
  suggestion?: string;
}

export function searchSampleIndex(index: SampleEntry[], q: string, limit = 30): SampleSearchResult {
  const query = parseSampleQuery(q);
  const termVariants = query.terms.map((t) => [t, ...(SYNONYMS[t] ?? [])]);

  const scored: { p: string; s: number }[] = [];
  for (const e of index) {
    let s = 0;
    let ok = true;
    for (let i = 0; i < query.terms.length; i++) {
      let best = 0;
      for (const v of termVariants[i]) {
        if (variantMatches(e.n, v)) best = Math.max(best, v === query.terms[i] ? 3 : 1);
      }
      if (!best) { ok = false; break; } // AND semantics: every term must hit
      s += best;
      if (variantMatches(e.f, query.terms[i])) s += 1; // filename hit beats folder hit
    }
    if (!ok) continue;
    if (query.bpm !== undefined) {
      if (e.bpm !== undefined) {
        const d = Math.abs(e.bpm - query.bpm);
        s += d === 0 ? 25 : d <= 2 ? 15 : d <= 5 ? 8 : 0;
      } else s += 3; // unknown tempo: still usable (warping)
    }
    if (query.key) {
      if (e.ks !== undefined) {
        const relRoot = query.key.minor ? (query.key.semitone + 3) % 12 : (query.key.semitone + 9) % 12;
        if (e.ks === query.key.semitone && !!e.km === query.key.minor) s += 25;
        else if (e.ks === relRoot && !!e.km !== query.key.minor) s += 10; // relative major/minor
        else if (e.ks === query.key.semitone) s += 4; // parallel major/minor
      } else s += 3;
    }
    scored.push({ p: e.p, s });
  }
  scored.sort((a, b) => b.s - a.s || (a.p < b.p ? -1 : 1));

  const result: SampleSearchResult = {
    total: scored.length,
    results: scored.slice(0, limit).map((x) => x.p),
    parsed: { terms: query.terms, ...(query.bpm !== undefined ? { bpm: query.bpm } : {}), ...(query.key ? { key: query.key.label } : {}) },
  };
  if (!scored.length) {
    result.suggestion =
      "没有匹配：减少关键词数量，或换个说法（同义词已内置，如 dark/warm/punchy）。BPM 和调式只影响排序、不会过滤掉结果。";
  }
  return result;
}

// -------------------------------------------------------------- index ----

/** Parse one indexed path into a searchable entry (called once per file at index-build time). */
export function toSampleEntry(fullPath: string): SampleEntry {
  const base = fullPath.split(/[\\/]/).pop() ?? fullPath;
  const stem = base.replace(/\.[^.]+$/, "");
  const n = normalize(fullPath);
  const f = normalize(stem);
  const bpm = parseBpm(f) ?? parseBpm(n);
  // Key parsing needs original case (bare "A" vs word "a") — filename first, then path.
  // Strip a Windows drive prefix first: "C:\…" would otherwise parse as key of C on every file.
  const key = parseKey(stem) ?? parseKey(fullPath.replace(/^[A-Za-z]:[\\/]/, ""));
  return {
    p: fullPath,
    n,
    f,
    ...(bpm !== undefined ? { bpm } : {}),
    ...(key ? { ks: key.semitone, km: key.minor } : {}),
  };
}
