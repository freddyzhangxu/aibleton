/**
 * Platform-specific filesystem decisions (macOS / Windows).
 *
 * server.ts stays platform-blind; every darwin/win32 branch lives here:
 *   - Ableton library locations (Core Library / Factory Packs / User Library)
 *   - sandbox-surviving fs primitives
 *   - persistent chat-store fallback location
 *   - system proxy detection (scutil / reg query)
 *
 * Windows note: the child-process escapes now have win32 counterparts built
 * on cmd.exe builtins (type / dir / if exist / mkdir) and PowerShell for
 * writes. If Live's Windows Extension Host turns out not to sandbox fs, the
 * direct fs calls succeed and the escapes never fire.
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);

// ---------- Sandbox-surviving fs primitives ----------

/**
 * Read a file under the user's home directory (~/.claude, ~/.codex, ~/.gemini).
 *
 * The installed Extension Host is launched by Live as
 *   node --permission --allow-fs-read=<Extensions dirs only> … --allow-child-process
 * so a direct fs.readFileSync of the home dir fails with ERR_ACCESS_DENIED.
 * But the permission model does not propagate to spawned children — and Live
 * explicitly grants --allow-child-process — so /bin/cat still reads those
 * files. Dev mode (`ableton-extensions-cli run`) has no --permission at all
 * and takes the direct path. If Ableton ever drops --allow-child-process the
 * fallback simply fails too and we behave as "no CLI config detected".
 */
/**
 * Run one cmd.exe command line outside the permission sandbox (Windows
 * counterpart of the /bin/* escapes). execSync passes the string through
 * unquoted, so embedded "quoted paths" keep working; `chcp 65001` first when
 * the command prints filenames, so piped output comes back UTF-8 regardless
 * of the system OEM codepage (GBK etc.).
 */
function cmdEscape(command: string, timeout = 10000, maxBuffer = 16 * 1024 * 1024): string {
  return execSync(command, {
    encoding: "utf8",
    timeout,
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

export function readHomeFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    // Only the sandbox denial is worth retrying via child process; a genuine
    // ENOENT just means the CLI is not installed/configured.
    if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") return null;
  }
  try {
    // `type` copies bytes verbatim, so UTF-8 files survive the round trip.
    if (process.platform === "win32") return cmdEscape(`type "${p}"`, 5000);
    return execFileSync("/bin/cat", [p], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** writeFileSync with the same child-process fallback as readHomeFile. */
export function writeHomeFile(p: string, content: string): void {
  try {
    fs.writeFileSync(p, content);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw e;
  }
  if (process.platform === "win32") {
    // cmd redirection would mangle multiline/special-char content, so writes
    // go through PowerShell reading stdin (WriteAllText = UTF-8 no BOM).
    const psPath = `'${p.replace(/'/g, "''")}'`;
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::InputEncoding = [Text.Encoding]::UTF8; [IO.File]::WriteAllText(${psPath}, [Console]::In.ReadToEnd())`,
      ],
      { input: content, timeout: 15000, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    return;
  }
  execFileSync("/usr/bin/tee", [p], {
    input: content,
    timeout: 5000,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

/** mkdirSync -p with the same child-process fallback as writeHomeFile. */
export function mkdirOutsideSandbox(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") throw e;
  }
  // cmd's mkdir creates intermediate directories on its own.
  if (process.platform === "win32") {
    cmdEscape(`mkdir "${dir}"`, 5000);
    return;
  }
  execFileSync("/bin/mkdir", ["-p", dir], { timeout: 5000, stdio: "ignore" });
}

/**
 * existsSync that survives the installed Extension Host sandbox (same trick as
 * readHomeFile): a denied statSync throws ERR_ACCESS_DENIED, then /bin/ls -d
 * answers from outside the permission model.
 */
export function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") return false;
  }
  if (process.platform === "win32") {
    try {
      cmdEscape(`if exist "${p}" (exit 0) else (exit 1)`, 5000);
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync("/bin/ls", ["-d", p], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** readdirSync (names only) with the same child-process fallback as pathExists. */
export function readdirNames(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED") return null;
  }
  if (process.platform === "win32") {
    try {
      // chcp 65001: without it dir prints filenames in the OEM codepage.
      const out = cmdEscape(`chcp 65001>nul & dir /b "${dir}"`, 5000);
      return out.split(/\r?\n/).filter(Boolean);
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("/bin/ls", ["-1", dir], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Recursive audio-file listing for roots the sandbox denies — /usr/bin/find
 * on macOS, `dir /s /b` on Windows. Full paths are printed (Windows: in
 * UTF-8 thanks to chcp 65001), extension filtering happens on our side.
 */
export function listAudioFilesViaFind(root: string, budget: number): string[] {
  if (process.platform === "win32") {
    try {
      const out = cmdEscape(`chcp 65001>nul & dir /b /s "${root}"`, 120000, 256 * 1024 * 1024);
      return out
        .split(/\r?\n/)
        .filter((l) => l && AUDIO_EXT.has(path.extname(l).toLowerCase()))
        .slice(0, budget);
    } catch {
      return [];
    }
  }
  const nameArgs = [...AUDIO_EXT].flatMap((ext) => ["-iname", `*${ext}`, "-o"]).slice(0, -1);
  try {
    const out = execFileSync("/usr/bin/find", [root, "-type", "f", "(", ...nameArgs, ")"], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter((l) => l && AUDIO_EXT.has(path.extname(l).toLowerCase()))
      .slice(0, budget);
  } catch {
    return [];
  }
}

// ---------- Ableton library locations ----------

/**
 * Install dirs under %ProgramData%\Ableton — the folder name varies between
 * versions and editions ("Live", "Live 12", "Live 12 Suite"), so scan
 * instead of guessing.
 */
function abletonProgramDataDirs(): string[] {
  const abletonDir = path.join(process.env.ProgramData ?? "C:\\ProgramData", "Ableton");
  return (readdirNames(abletonDir) ?? [])
    .filter((name) => /^live/i.test(name))
    .map((name) => path.join(abletonDir, name));
}

// ---------- Ableton library discovery ----------

export interface AbletonLibraryPaths {
  /** Roots identified as a User Library (cfg path contains a "User Library" segment). */
  userLibraries: string[];
  /** Roots containing installed packs (cfg path contains "Factory Packs"/"Packages"). */
  packsRoots: string[];
  /**
   * Other existing directories recorded in Library.cfg — typically custom-named
   * library roots the user picked in Preferences → Library (Live does not force
   * a conventional folder name there).
   */
  genericRoots: string[];
  /** "<install>/Resources/Core Library/Samples" of every detected install. */
  coreLibrarySamples: string[];
}

/**
 * Library.cfg of every installed Live version (per-user, plus the machine-wide
 * CommonConfiguration Ableton supports for shared deployments). Live 10+
 * stores the User Library location and the Packs installation folder here —
 * not in Preferences.cfg. Folder names vary ("Live 12", "Live 12.1.10"), so
 * enumerate rather than match the host version; consumers union everything
 * and filter by existence, which also tolerates stale versions. The file sits
 * directly under the version dir on macOS, under its Preferences/ subdir on
 * Windows — probe both.
 */
function libraryCfgPaths(): string[] {
  const roots =
    process.platform === "win32"
      ? [
          path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Ableton"),
          path.join(process.env.ProgramData ?? "C:\\ProgramData", "Ableton", "CommonConfiguration"),
        ]
      : [path.join(os.homedir(), "Library", "Preferences", "Ableton")];
  const out: string[] = [];
  for (const root of roots) {
    for (const name of readdirNames(root) ?? []) {
      if (!/^live/i.test(name)) continue;
      const verDir = path.join(root, name);
      out.push(path.join(verDir, "Library.cfg"), path.join(verDir, "Preferences", "Library.cfg"));
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

interface CfgPaths {
  /** User Library dir: ProjectPath (parent) joined with ProjectName (folder). */
  userLibraries: string[];
  /** Packs roots: parent of every installed pack, plus the configured install folder. */
  packsRoots: string[];
  /** Every absolute path literal in the file (shape-based fallback + Places). */
  allAbs: string[];
}

/**
 * Extract content locations from Library.cfg. The stable entries (observed
 * Live 11–12): each installed pack is a <LibrarySliceInfo Path="…">, the
 * User Library is <UserLibrary><LibraryProject><ProjectPath/ProjectName>,
 * a customized Packs folder is <PreferredFactoryPacksInstallationPath>, and
 * user-added Places are <UserFolderInfo Path="…">. Ableton does not publish
 * the schema, so allAbs additionally feeds a shape-based fallback below.
 */
function parseLibraryCfg(xml: string): CfgPaths {
  const userLibraries: string[] = [];
  const packsRoots: string[] = [];
  const allAbs = new Set<string>();

  const userLibBlock = /<UserLibrary>[\s\S]*?<\/UserLibrary>/.exec(xml)?.[0];
  if (userLibBlock) {
    const parent = /<ProjectPath\s+Value="([^"]*)"/.exec(userLibBlock)?.[1];
    const folder = /<ProjectName\s+Value="([^"]*)"/.exec(userLibBlock)?.[1];
    if (parent) userLibraries.push(path.join(decodeXml(parent), decodeXml(folder ?? "User Library")));
  }

  const preferred = /<PreferredFactoryPacksInstallationPath\s+Value="([^"]*)"/.exec(xml)?.[1];
  if (preferred) packsRoots.push(decodeXml(preferred));

  for (const m of xml.matchAll(/<LibrarySliceInfo\b[^>]*>/g)) {
    const p = /\bPath="([^"]*)"/.exec(m[0])?.[1];
    if (p) packsRoots.push(path.dirname(decodeXml(p)));
  }

  const re = process.platform === "win32" ? /[A-Za-z]:\\[^"<>\r\n]+/g : /\/[^"<>\r\n]+/g;
  for (const m of xml.matchAll(re)) {
    const p = decodeXml(m[0]).replace(/[\\/]+$/, "").trim();
    if (p.length > (process.platform === "win32" ? 3 : 1)) allAbs.add(p);
  }

  return { userLibraries, packsRoots, allAbs: [...allAbs] };
}

/**
 * The real Documents folder. OneDrive's Known Folder Move redirects it to
 * ~\OneDrive\Documents, which homedir()+"Documents" gets wrong; the shell
 * keeps the truth under User Shell Folders\Personal (may be REG_EXPAND_SZ).
 */
function windowsDocumentsDir(): string {
  const fallback = path.join(os.homedir(), "Documents");
  try {
    const out = execFileSync(
      "reg",
      [
        "query",
        String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`,
        "/v",
        "Personal",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    const val = /Personal\s+REG(?:_EXPAND)?_SZ\s+(.+?)\s*$/m.exec(out)?.[1];
    if (val) {
      return val.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
    }
  } catch {
    // reg unavailable — assume the default.
  }
  return fallback;
}

/** InstallLocation of every Ableton Live from the uninstall registry keys. */
function windowsLiveInstallDirs(): string[] {
  const hiveRoots = [
    String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
    String.raw`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
  ];
  const out = new Set<string>();
  for (const hiveRoot of hiveRoots) {
    let listing: string;
    try {
      listing = execFileSync("reg", ["query", hiveRoot], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const line of listing.split(/\r?\n/)) {
      const key = line.trim();
      if (!/ableton/i.test(key)) continue;
      try {
        const detail = execFileSync("reg", ["query", key, "/v", "InstallLocation"], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        const loc = /InstallLocation\s+REG_SZ\s+(.+?)\s*$/.exec(detail)?.[1];
        if (loc) out.add(loc);
      } catch {
        // Value absent for this key.
      }
    }
  }
  return [...out];
}

let cachedLibraryPaths: AbletonLibraryPaths | null = null;

/**
 * Best-effort discovery of Ableton's content roots, driven by Live's own
 * configuration so user-customized locations (Preferences → Library) are
 * found instead of guessed. Layers: Library.cfg of every Live version →
 * registry install dirs (Core Library) → defaults appended by the callers.
 * Cached: nothing here changes while Live is running, and existence checks
 * are re-done live by the consumers on every call.
 */
export function resolveAbletonLibraryPaths(): AbletonLibraryPaths {
  if (cachedLibraryPaths) return cachedLibraryPaths;

  const userLibraries = new Set<string>();
  const packsRoots = new Set<string>();
  const genericRoots = new Set<string>();
  const coreLibrarySamples = new Set<string>();

  for (const cfg of libraryCfgPaths()) {
    const xml = readHomeFile(cfg);
    if (!xml) continue;
    const parsed = parseLibraryCfg(xml);
    for (const p of parsed.userLibraries) userLibraries.add(p);
    for (const p of parsed.packsRoots) packsRoots.add(p);
    // Shape-based fallback over every absolute path in the file: catches
    // layouts/keys the structured parse misses, and pulls in user Places
    // (<UserFolderInfo>) — folders the user explicitly told Live about,
    // which are exactly where their own samples live.
    for (const raw of parsed.allAbs) {
      const userLib = /^(.+?[\\/]User Library)(?=[\\/]|$)/i.exec(raw)?.[1];
      const packs = /^(.+?[\\/](?:Factory Packs|Packages))(?=[\\/]|$)/i.exec(raw)?.[1];
      if (userLib) {
        userLibraries.add(userLib);
      } else if (packs) {
        packsRoots.add(packs);
      } else if (path.parse(raw).root !== raw && pathExists(raw)) {
        // Custom-named root or Place (any folder may serve as the User
        // Library / Packs folder). Drive roots are rejected to keep the
        // index bounded.
        genericRoots.add(raw);
      }
    }
  }

  if (process.platform === "win32") {
    // Core Library ships under %ProgramData% (normal case); install dirs from
    // the registry cover setups that keep resources next to the program.
    for (const d of abletonProgramDataDirs()) {
      coreLibrarySamples.add(path.join(d, "Resources", "Core Library", "Samples"));
    }
    for (const install of windowsLiveInstallDirs()) {
      coreLibrarySamples.add(path.join(install, "Resources", "Core Library", "Samples"));
    }
  }

  cachedLibraryPaths = {
    userLibraries: [...userLibraries].filter(pathExists),
    packsRoots: [...packsRoots].filter(pathExists),
    genericRoots: [...genericRoots],
    coreLibrarySamples: [...coreLibrarySamples].filter(pathExists),
  };
  return cachedLibraryPaths;
}

/**
 * Candidate roots for the local sample index; non-existent ones are dropped.
 *
 *   Both     every root Live itself records in Library.cfg (covers libraries
 *            and Packs folders the user moved in Preferences → Library)
 *   macOS    ~/Music/Ableton/{User Library,Factory Packs} + the Core Library
 *            inside every /Applications/Ableton Live 12*.app
 *   Windows  Documents\Ableton\{User Library,Factory Packs} (OneDrive-aware)
 *            + the Core Library of every detected install
 * Splice drops its samples into the same home-relative dirs on both platforms.
 */
export function sampleRoots(): string[] {
  const home = os.homedir();
  const lib = resolveAbletonLibraryPaths();
  const candidates = [
    path.join(home, "Splice"),
    path.join(home, "Music", "Splice"),
    path.join(home, "Documents", "Splice"),
    ...lib.userLibraries,
    ...lib.packsRoots,
    ...lib.genericRoots,
    ...lib.coreLibrarySamples,
  ];
  if (process.platform === "win32") {
    const docs = windowsDocumentsDir();
    candidates.push(
      path.join(docs, "Ableton", "User Library"),
      path.join(docs, "Ableton", "Factory Packs"),
    );
  } else {
    candidates.push(
      path.join(home, "Music", "Ableton", "User Library"),
      path.join(home, "Music", "Ableton", "Factory Packs"),
    );
    // Core Library of every installed Live 12 app
    for (const app of readdirNames("/Applications") ?? []) {
      if (/^Ableton Live 12.*\.app$/.test(app)) {
        candidates.push(`/Applications/${app}/Contents/App-Resources/Core Library/Samples`);
      }
    }
  }
  // Drop roots already contained in another root — otherwise the index walks
  // those trees twice and every file appears more than once.
  const existing = [...new Set(candidates)].filter((p) => pathExists(p));
  return existing.filter(
    (p, i) => !existing.some((q, j) => j !== i && p.startsWith(q + path.sep)),
  );
}

/**
 * Candidate roots of the Drum Essentials pack's Drums sample folder: every
 * packs root Live records (any name — a custom Packs folder need not contain
 * "Factory Packs"), then the platform defaults. Existence is checked by the
 * caller so its error message can list everything that was tried.
 */
export function kitRoots(): string[] {
  const packSubdir = path.join("Drum Essentials", "Samples", "Drums");
  const lib = resolveAbletonLibraryPaths();
  const roots = [...lib.packsRoots, ...lib.genericRoots].map((r) => path.join(r, packSubdir));
  if (process.platform === "win32") {
    roots.push(
      path.join(windowsDocumentsDir(), "Ableton", "Factory Packs", packSubdir),
      ...abletonProgramDataDirs().map((d) =>
        path.join(d, "Resources", "Factory Packs", packSubdir),
      ),
    );
  } else {
    roots.push(
      path.join(os.homedir(), "Music", "Ableton", "Factory Packs", packSubdir),
      path.join("/Users", "Shared", "Ableton", "Factory Packs", packSubdir),
    );
  }
  return [...new Set(roots)];
}

// ---------- Persistent chat store fallback ----------

/**
 * Where chats.json lives when the SDK reports no storageDirectory (beta).
 * macOS: ~/Library/Application Support; Windows: %APPDATA%.
 */
export function storeFallbackPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "AIbleton", "chats.json");
  }
  return path.join(os.homedir(), "Library", "Application Support", "AIbleton", "chats.json");
}

// ---------- System proxy detection ----------

/**
 * System HTTP(S) proxy as http://host:port, or null when none is configured.
 * macOS reads `scutil --proxy`; Windows reads the WinINet settings from the
 * registry. Env vars (AIBLETON_PROXY / HTTPS_PROXY / …) take precedence and
 * are checked by the caller.
 */
export function detectSystemProxy(): string | null {
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 });
      const enabled = /HTTPSEnable\s*:\s*1/.test(out) || /HTTPEnable\s*:\s*1/.test(out);
      const host =
        /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(out)?.[1];
      const port =
        /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(out)?.[1];
      if (enabled && host) return `http://${host}:${port ?? "7890"}`;
    } catch {
      // scutil unavailable — no proxy.
    }
    return null;
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`],
        { encoding: "utf8", timeout: 3000 },
      );
      const enabledHex = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)?.[1];
      if (!enabledHex || parseInt(enabledHex, 16) === 0) return null;
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1];
      if (!server) return null;
      // Either one "host:port" for all protocols, or a per-protocol list
      // ("http=h:p;https=h:p") — prefer the https entry, then http.
      const hostPort =
        /https=([^;\s]+)/i.exec(server)?.[1] ??
        /http=([^;\s]+)/i.exec(server)?.[1] ??
        (server.includes("=") ? null : server);
      if (hostPort) return `http://${hostPort}`;
    } catch {
      // reg unavailable — no proxy.
    }
    return null;
  }
  return null;
}
