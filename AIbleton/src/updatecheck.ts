/**
 * Update check against GitHub Releases — at most once per 24h, cached in
 * providers.json (toolState.updateInfo, persisted by server.ts). Fully
 * silent by design: any failure leaves checkedAt untouched so the next
 * host start retries instead of waiting out another 24h, and nothing ever
 * surfaces in the UI unless a newer version was actually confirmed.
 */

import { URL } from "node:url";
import { rawGet, readAll, detectProxy } from "./http.js";
import { toolHooks, toolState } from "./state.js";

// Stamped by esbuild from package.json (same define as server.ts).
declare const __APP_VERSION__: string | undefined;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

const RELEASE_API = new URL(
  "https://api.github.com/repos/freddyzhangxu/aibleton/releases/latest",
);
export const RELEASES_PAGE = "https://github.com/freddyzhangxu/aibleton/releases/latest";
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** "v0.9.11" / "0.9.11" → [0, 9, 11]; anything else → null (prerelease tags
 * never ship — the Live installer rejects non-X.Y.Z manifests). */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false; // "dev" builds never banner.
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

/**
 * Check for a newer release. Skips the network entirely when the cache is
 * fresher than 24h (unless force = true, e.g. the user clicked "check now").
 */
export async function checkForUpdate(force = false): Promise<void> {
  const info = toolState.updateInfo;
  if (
    !force &&
    info.checkedAt !== undefined &&
    Date.now() - info.checkedAt < UPDATE_INTERVAL_MS
  ) {
    return;
  }
  // Manual timeout — bare AbortSignal.timeout() crashes the extension sandbox.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await rawGet(RELEASE_API, {
      headers: {
        "user-agent": "aibleton-update-check",
        accept: "application/vnd.github+json",
      },
      proxy: detectProxy(),
      signal: ctl.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      await readAll(res.stream).catch(() => "");
      return;
    }
    const data = JSON.parse(await readAll(res.stream)) as Record<string, unknown>;
    const tag = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!parseVersion(tag)) return;
    info.latest = tag.replace(/^v/, "");
    info.url = typeof data.html_url === "string" ? data.html_url : RELEASES_PAGE;
    info.checkedAt = Date.now();
    toolHooks.saveManualConfigs();
    if (isNewer(info.latest, APP_VERSION)) {
      console.log(`[ai-assistant] 发现新版本 v${info.latest}（当前 v${APP_VERSION}）— ${info.url}`);
    }
  } catch {
    // Silent: checkedAt stays stale, so the next host start retries.
  } finally {
    clearTimeout(timer);
  }
}

let loopStarted = false;

/** Kick the startup check (no-op if the cache is fresh) and re-check every
 * 24h for as long as the host stays alive (Live can run for days). */
export function startUpdateLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  void checkForUpdate(false);
  const t = setInterval(() => void checkForUpdate(false), UPDATE_INTERVAL_MS);
  t.unref?.();
}
