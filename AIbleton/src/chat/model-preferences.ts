import type { Provider } from "../config/local.js";

export interface ModelPreferences { favorites: string[]; recent: string[] }

export function modelPreferenceScope(provider: Provider, baseUrl: string): string {
  return `${provider}:${baseUrl.replace(/\/+$/, "")}`;
}

export function normalizeModelPreferences(value: unknown): ModelPreferences {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const ids = (raw: unknown, limit: number): string[] => Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === "string" && Boolean(id.trim()) && id.length <= 256).map((id) => id.trim()))].slice(0, limit)
    : [];
  return { favorites: ids(obj.favorites, 100), recent: ids(obj.recent, 5) };
}

/** favorite=true/false changes only favorites; omitted records a selection. */
export function updateModelPreferences(value: unknown, model: string, favorite?: boolean): ModelPreferences {
  const prefs = normalizeModelPreferences(value);
  const id = model.trim();
  if (!id || id.length > 256) return prefs;
  if (favorite === undefined) prefs.recent = [id, ...prefs.recent.filter((m) => m !== id)].slice(0, 5);
  else prefs.favorites = favorite
    ? [...new Set([...prefs.favorites, id])].slice(0, 100)
    : prefs.favorites.filter((m) => m !== id);
  return prefs;
}
