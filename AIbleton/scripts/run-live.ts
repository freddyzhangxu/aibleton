import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runningLivePaths, selectLiveTarget } from "./live-target.js";

const projectDir = fileURLToPath(new URL("../", import.meta.url));

function detectRunningLive(): string[] {
  if (process.platform === "darwin") {
    const output = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 5000 });
    return runningLivePaths(output.split(/\r?\n/), process.platform);
  }
  if (process.platform === "win32") {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*Live*.exe' } | ForEach-Object { $_.ExecutablePath }",
    ], { encoding: "utf8", timeout: 10000, windowsHide: true });
    return runningLivePaths(output.split(/\r?\n/), process.platform);
  }
  return [];
}

function main() {
  try { process.loadEnvFile(path.join(projectDir, ".env")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      live: { type: "string" },
      "storage-directory": { type: "string" },
      "temp-directory": { type: "string" },
      verbose: { type: "boolean", short: "v" },
    },
  });
  let running: string[] = [];
  try { running = detectRunningLive(); } catch (error) {
    console.warn(`AIbleton: Live detection failed; falling back to EXTENSION_HOST_PATH. ${String(error)}`);
  }
  const target = selectLiveTarget({
    running,
    configured: process.env.EXTENSION_HOST_PATH,
    explicit: values.live,
    major: values.version,
  });
  console.log(`AIbleton developer host: ${target}`);
  const cli = fileURLToPath(new URL("../node_modules/@ableton-extensions/cli/dist/cli.mjs", import.meta.url));
  const args = [cli, "run", ...positionals, "--live", target];
  for (const option of ["storage-directory", "temp-directory"] as const) {
    if (values[option]) args.push(`--${option}`, values[option]);
  }
  if (values.verbose) args.push("--verbose");
  const child = spawn(process.execPath, args, { cwd: projectDir, stdio: "inherit" });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
