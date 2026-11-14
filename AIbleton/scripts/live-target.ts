export interface LiveTargetOptions {
  running: string[];
  configured?: string;
  explicit?: string;
  major?: string;
}

export function selectLiveTarget(options: LiveTargetOptions): string {
  const running = [...new Set(options.running)];
  // --live chooses the host binary, not the IPC endpoint. Live versions share
  // the developer channel, so choosing a binary cannot safely route two apps.
  if (running.length > 1) {
    throw new Error("Run only one Live instance during extension development: Live 12 and 13 share the developer connection channel. Close the other Live app and retry.");
  }
  if (options.explicit) return options.explicit;
  const major = options.major;
  if (major && !["12", "13"].includes(major)) throw new Error("Live version must be 12 or 13.");
  const matchesVersion = (livePath: string) => !major || new RegExp(`Live ${major}(?=[\\s./\\\\]|$)`, "i").test(livePath);
  const candidates = running.filter(matchesVersion);
  if (candidates.length === 1) return candidates[0];
  if (running.length) throw new Error(`Open Live ${major} before starting this developer session.`);
  if (options.configured && matchesVersion(options.configured)) return options.configured;
  throw new Error(`Open Live${major ? ` ${major}` : " 12 or 13"}, or supply --live <path> / EXTENSION_HOST_PATH.`);
}

export function runningLivePaths(commands: string[], platform: string): string[] {
  const paths = commands.flatMap((command) => {
    const executable = command.trim();
    if (platform === "darwin") {
      const match = executable.match(/^(\/.*\/Ableton Live[^/]*\.app)\/Contents\/MacOS\/Live$/);
      return match ? [match[1]] : [];
    }
    if (platform === "win32" && /^[A-Z]:\\.*\\(?:Ableton Live[^\\]*|Live)\.exe$/i.test(executable)) {
      return [executable];
    }
    return [];
  });
  return [...new Set(paths)];
}
