/* Server-wide web search settings (PROTOCOL-v6.md 1.1b): DB value (table server_settings, key "search") wins, env/config.env are defaults.
   API keys are stored encrypted (enc1:, same mechanism as provider keys) and are never returned. */
import { db } from "../db.js";
import { AuthError } from "../auth.js";
import { decryptSecret, encryptSecret } from "../secret.js";

export type SearchMode = "searxng" | "builtin" | "api";
export const SEARCH_MODES: readonly SearchMode[] = ["searxng", "builtin", "api"];
export const BUILTIN_ENGINE_IDS = ["bing-rss", "wikipedia", "duckduckgo"] as const;
export const API_ENGINE_IDS = ["brave", "tavily"] as const;

export interface SearchConfig {
  mode: SearchMode;
  fallback: boolean;
  searxngUrl: string;
  engines: { builtin: string[]; api: string[] };
  keys: { brave: string; tavily: string };
}

interface Stored {
  mode?: SearchMode;
  fallback?: boolean;
  searxngUrl?: string | null;
  engines?: { builtin?: string[]; api?: string[] };
  braveApiKey?: string | null;
  tavilyApiKey?: string | null;
}

const KEY = "search";

function readStored(): Stored {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}

function writeStored(s: Stored): void {
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(s), Date.now());
}

const pick = (ids: unknown, allowed: readonly string[]): string[] | undefined =>
  Array.isArray(ids) ? [...new Set(ids.map((x) => String(x).trim().toLowerCase()))].filter((x) => allowed.includes(x)) : undefined;

const envEngines = (): string[] | undefined => {
  const raw = (process.env.SEARCH_ENGINES ?? "").trim();
  return raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
};

/** The effective configuration: DB value, else env default, else built-in default. */
export function getSearchConfig(): SearchConfig {
  const s = readStored();
  const env = process.env;
  const searxngUrl = (s.searxngUrl !== undefined ? s.searxngUrl ?? "" : (env.SEARXNG_URL ?? "")).trim();
  const envMode = (env.SEARCH_BACKEND ?? "").trim().toLowerCase();
  const mode: SearchMode =
    s.mode && SEARCH_MODES.includes(s.mode) ? s.mode
    : SEARCH_MODES.includes(envMode as SearchMode) ? (envMode as SearchMode)
    : searxngUrl ? "searxng" : "builtin";
  const fromEnv = envEngines();
  const builtin = pick(s.engines?.builtin, BUILTIN_ENGINE_IDS) ?? (fromEnv ? pick(fromEnv, BUILTIN_ENGINE_IDS) : undefined) ?? [...BUILTIN_ENGINE_IDS];
  const api = pick(s.engines?.api, API_ENGINE_IDS) ?? (fromEnv ? pick(fromEnv, API_ENGINE_IDS) : undefined) ?? [...API_ENGINE_IDS];
  const key = (stored: string | null | undefined, envName: string): string =>
    (stored !== undefined ? decryptSecret(stored ?? "") : (env[envName] ?? "")).trim();
  return {
    mode,
    fallback: s.fallback ?? !/^(0|false)$/i.test((env.SEARCH_FALLBACK ?? "").trim()),
    searxngUrl,
    engines: { builtin, api },
    keys: { brave: key(s.braveApiKey, "BRAVE_API_KEY"), tavily: key(s.tavilyApiKey, "TAVILY_API_KEY") },
  };
}

/** API key for an engine's `keyEnv` (DB first, env default). */
export function engineApiKey(keyEnv: string | undefined): string {
  if (keyEnv === "BRAVE_API_KEY") return getSearchConfig().keys.brave;
  if (keyEnv === "TAVILY_API_KEY") return getSearchConfig().keys.tavily;
  return "";
}

/** Key values that must be scrubbed from any error text. */
export function secretValues(): string[] {
  const k = getSearchConfig().keys;
  return [k.brave, k.tavily].filter((v) => v.length >= 8);
}

export function searxngHost(url: string): string | null {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).host; } catch { return null; }
}

/** What GET /search/config returns: never the keys; the URL as host only unless `full` (loopback-only local admin). */
export function publicSearchConfig(full = false): Record<string, unknown> {
  const c = getSearchConfig();
  return {
    mode: c.mode,
    fallback: c.fallback,
    searxngHost: c.searxngUrl ? searxngHost(c.searxngUrl) : null,
    ...(full ? { searxngUrl: c.searxngUrl } : {}),
    engines: c.engines,
    keySet: { brave: !!c.keys.brave, tavily: !!c.keys.tavily },
  };
}

/** Admin update. Unknown fields are ignored; a bad value is a 400. Keys: string = set, null = remove. */
export function updateSearchConfig(body: any): void {
  const b = body && typeof body === "object" ? body : {};
  const s = readStored();
  const bad = (m: string): never => { throw new AuthError(m, 400); };
  if (b.mode !== undefined) {
    if (!SEARCH_MODES.includes(b.mode)) bad("mode must be searxng, builtin or api");
    s.mode = b.mode;
  }
  if (b.fallback !== undefined) {
    if (typeof b.fallback !== "boolean") bad("fallback must be a boolean");
    s.fallback = b.fallback;
  }
  if (b.searxngUrl !== undefined) {
    if (b.searxngUrl === null || b.searxngUrl === "") s.searxngUrl = null;
    else {
      const t = typeof b.searxngUrl === "string" ? b.searxngUrl.trim() : "";
      if (!/^https?:\/\/[^\s"']+$/i.test(t) || !searxngHost(t)) bad("searxngUrl must be an http(s) URL");
      s.searxngUrl = t;
    }
  }
  if (b.engines !== undefined) {
    if (!b.engines || typeof b.engines !== "object") bad("engines must be an object");
    s.engines = { ...(s.engines ?? {}) };
    if (b.engines.builtin !== undefined) {
      if (!Array.isArray(b.engines.builtin)) bad("engines.builtin must be an array");
      s.engines.builtin = pick(b.engines.builtin, BUILTIN_ENGINE_IDS);
    }
    if (b.engines.api !== undefined) {
      if (!Array.isArray(b.engines.api)) bad("engines.api must be an array");
      s.engines.api = pick(b.engines.api, API_ENGINE_IDS);
    }
  }
  for (const [field, prop] of [["braveApiKey", "braveApiKey"], ["tavilyApiKey", "tavilyApiKey"]] as const) {
    if (b[field] === undefined) continue;
    if (b[field] === null || b[field] === "") s[prop] = null;
    else if (typeof b[field] === "string" && b[field].trim().length >= 8 && b[field].length <= 300 && !/\s/.test(b[field].trim())) s[prop] = encryptSecret(b[field].trim());
    else bad(`${field} is not a valid key`);
  }
  writeStored(s);
}
