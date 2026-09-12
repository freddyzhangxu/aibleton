import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { AudioGenConfig } from "./audiogen.js";
import type { LocalConfig, Provider } from "./config/local.js";
import type { SampleEntry } from "./samplemeta.js";

export type Ctx = ExtensionContext<"1.0.0">;

/**
 * The user's durable musical identity, persisted as memory.json in the same
 * storage directory (same readHomeFile/writeHomeFile pattern as providers.json,
 * but a separate file so it stays easy to hand-edit or share). Injected into
 * the system prompt of every chat; kept fresh by the update_memory tool.
 * All fields optional — an empty object means "no memory yet".
 */
export type ArtistMemory = {
  name?: string;
  genres?: string[];
  bpmMin?: number;
  bpmMax?: number;
  keys?: string[];
  sound?: string[];
  artists?: string[];
  notes?: string;
};

/**
 * Mutable cross-module state shared between server.ts and tools/. Owned by
 * server.ts (it loads/persists every field); tools read and occasionally
 * write through this single container so the dependency arrows stay one-way
 * (server → tools, never tools → server).
 */
export const toolState = {
  /** Web-search toggle from the settings UI, persisted in providers.json.
   * Default OFF: web_search/web_fetch are advertised to the model (and allowed
   * to run) only when the user explicitly turns this on. */
  webSettings: { enabled: false },
  /** Ableton Move pairing state (host + challenge-response token), persisted
   * in providers.json under "move". */
  moveSettings: {} as { host?: string; token?: string },
  artistMemory: {} as ArtistMemory,
  /** Resolved audio-generation config for the running chat task. */
  activeAudioConfig: null as AudioGenConfig | null,
  /** UI language of the running chat task — feeds the web tools' search locale
   * (same per-request lifetime as activeAudioConfig; busy = one task at a time). */
  activeLanguage: undefined as string | undefined,
  abortCtl: null as AbortController | null,
};

/**
 * Late-bound functions owned by server.ts that tools must call. Assigned by
 * server.ts at module init; every field is only invoked at request time, so
 * the placeholder throws are unreachable in practice.
 */
export const toolHooks = {
  saveArtistMemory: (): void => {
    throw new Error("toolHooks.saveArtistMemory not initialized");
  },
  saveManualConfigs: (): void => {
    throw new Error("toolHooks.saveManualConfigs not initialized");
  },
  /** Drop the cached sample index so search_samples sees new files. */
  invalidateSampleIndex: (): void => {
    throw new Error("toolHooks.invalidateSampleIndex not initialized");
  },
  buildSampleIndex: (): SampleEntry[] => {
    throw new Error("toolHooks.buildSampleIndex not initialized");
  },
  /** Append a line to ai-debug.log next to chats.json. */
  debugLog: (_context: Ctx, _line: string): void => {
    throw new Error("toolHooks.debugLog not initialized");
  },
  /** Settings-UI audio autoRefine toggle, read by the tool gate. */
  getAudioAutoRefine: (): boolean => {
    throw new Error("toolHooks.getAudioAutoRefine not initialized");
  },
  /** Settings-UI provider config (providers.json), read by resolveConfig. */
  getManualConfig: (_provider: Provider): LocalConfig | undefined => {
    throw new Error("toolHooks.getManualConfig not initialized");
  },
  handleSetGoal: (_context: Ctx, _input: Record<string, unknown>): unknown => {
    throw new Error("toolHooks.handleSetGoal not initialized");
  },
  handleSetPlan: (_context: Ctx, _input: Record<string, unknown>): unknown => {
    throw new Error("toolHooks.handleSetPlan not initialized");
  },
};
