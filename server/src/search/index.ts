/* Web search (PROTOCOL-v6.md 1.1b): a router over three options (searxng | builtin | api) with automatic fallback.
   Settings come from config.ts (DB value, else env default). All back-references from the engine modules to this file are
   type-only, so the imports below have no runtime cycle. */
import { SEARCH_MODES, getSearchConfig, searxngHost, type SearchConfig, type SearchMode } from "./config.js";
import { aggregator, type EngineStatus } from "./builtin/aggregator.js";
import { engineById, enabledEngineIds, keyIsSet } from "./builtin/table.js";
import { searxngBackend } from "./searxng.js";

export interface SearchResult { title: string; url: string; snippet?: string }
export interface SearchOpts { limit: number; signal?: AbortSignal }
export interface SearchBackend {
  name: string;
  /** host:port only (never credentials / path) */
  host: string;
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
  /** Cheap reachability check; never throws. `reachable` = the server answered HTTP at all. */
  probe(signal?: AbortSignal): Promise<{ reachable: boolean; error?: string }>;
  /** Legacy hook for per-engine state; the router no longer implements it (see searchStatus). */
  status?(): object;
}

export type SearchModeId = SearchMode;
type EngineGroupId = "builtin" | "api";

export interface SearchTry { mode: SearchMode; ok: boolean; error?: string }
export interface SearchOutcome { results: SearchResult[]; usedBackend: SearchMode; tried: SearchTry[] }

/** Order used for automatic fallback. */
const FALLBACK_ORDER: readonly SearchMode[] = ["searxng", "builtin", "api"];

let last: { at: number; usedBackend: SearchMode; mode: SearchMode } | null = null;

/** The last successful search: which backend answered and which mode was configured then. */
export function lastSearchInfo(): { at: number; usedBackend: SearchMode; mode: SearchMode } | null {
  return last ? { ...last } : null;
}

export const searchMaxResults = (): number => {
  const n = Number(process.env.SEARCH_MAX_RESULTS ?? 5);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 5;
};

/** One numbered result line: `[n] title — url — snippet`. */
export function formatLine(index: number, r: SearchResult): string {
  return `[${index}] ${r.title} — ${r.url}${r.snippet ? ` — ${r.snippet.replace(/\s+/g, " ").trim()}` : ""}`;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether a mode can be used with the current settings, and why not. */
export function modeUsable(mode: SearchModeId, cfg: SearchConfig = getSearchConfig()): { usable: boolean; reason?: string } {
  if (mode === "searxng") return cfg.searxngUrl ? { usable: true } : { usable: false, reason: "SearXNG URL not set" };
  if (mode === "builtin") {
    return enabledEngineIds("builtin", cfg).length ? { usable: true } : { usable: false, reason: "no built-in engine enabled" };
  }
  const ready = enabledEngineIds("api", cfg).some((id) => {
    const def = engineById(id);
    return !!def && keyIsSet(def);
  });
  return ready ? { usable: true } : { usable: false, reason: "no API key set" };
}

/** Runs ONE mode. Throws on failure. */
export async function searchVia(mode: SearchModeId, query: string, opts: SearchOpts): Promise<SearchResult[]> {
  if (mode === "searxng") {
    const b = searxngBackend();
    if (!b) throw new Error("SearXNG URL not set");
    return b.search(query, opts);
  }
  return aggregator.search(query, opts, mode);
}

/**
 * Searches with the configured mode, falling back (when enabled) to the other usable modes in the order
 * searxng -> builtin -> api. `only` runs just that mode, without fallback. A caller abort rethrows immediately.
 */
export async function searchWithFallback(query: string, opts: SearchOpts, only?: SearchMode): Promise<SearchOutcome> {
  const cfg = getSearchConfig();
  const tried: SearchTry[] = [];

  // Runs one mode and records it. Returns its results, or null when it is unusable or failed.
  const run = async (mode: SearchMode): Promise<SearchResult[] | null> => {
    const u = modeUsable(mode, cfg);
    if (!u.usable) {
      tried.push({ mode, ok: false, error: u.reason });
      return null;
    }
    try {
      const results = await searchVia(mode, query, opts);
      tried.push({ mode, ok: true });
      return results;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      tried.push({ mode, ok: false, error: msgOf(e) });
      return null;
    }
  };
  const done = (mode: SearchMode, results: SearchResult[]): SearchOutcome => {
    last = { at: Date.now(), usedBackend: mode, mode: cfg.mode };
    return { results, usedBackend: mode, tried };
  };
  // Every tried mode failed: rethrow the single error as is, or list all of them.
  const fail = (): never => {
    if (tried.length === 1) throw new Error(tried[0].error ?? "search failed");
    throw new Error(`Web search failed (${tried.map((t) => `${t.mode}: ${t.error ?? "failed"}`).join("; ")})`);
  };

  if (only) {
    const r = await run(only);
    return r ? done(only, r) : fail();
  }

  const primary = cfg.mode;
  let zero: SearchMode | null = null; // first mode that answered without error but with no results
  const first = await run(primary);
  if (first) {
    if (first.length) return done(primary, first);
    zero = primary;
  }
  if (cfg.fallback) {
    for (const mode of FALLBACK_ORDER) {
      if (mode === primary) continue;
      const r = await run(mode);
      if (r) {
        if (r.length) return done(mode, r);
        zero ??= mode;
      }
    }
  }
  if (zero) return done(zero, []);
  return fail();
}

/**
 * The router as a SearchBackend, or null. Available when the active mode is usable, or when fallback is on and any
 * mode is usable.
 */
export function getSearchBackend(): SearchBackend | null {
  const cfg = getSearchConfig();
  const activeOk = modeUsable(cfg.mode, cfg).usable;
  const anyOk = cfg.fallback && SEARCH_MODES.some((m) => modeUsable(m, cfg).usable);
  if (!activeOk && !anyOk) return null;
  const mode = cfg.mode;
  return {
    name: mode,
    host: mode === "searxng" ? (searxngHost(cfg.searxngUrl) ?? "searxng") : mode,
    search: (query, opts) => searchWithFallback(query, opts).then((o) => o.results),
    probe: async (signal) => {
      if (mode !== "searxng") return { reachable: true };
      const b = searxngBackend();
      return b ? b.probe(signal) : { reachable: false, error: "SearXNG URL not set" };
    },
  };
}

// SearXNG probe result, cached for OMNICHAT_SEARCH_STATUS_TTL_MS (default 5 s) per URL.
let probeCache: { at: number; url: string; value: { reachable: boolean; error?: string } } | null = null;
const statusTtl = (): number => {
  const n = Number(process.env.OMNICHAT_SEARCH_STATUS_TTL_MS ?? 5000);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
};

async function searxngProbeCached(url: string): Promise<{ reachable: boolean; error?: string }> {
  if (probeCache && probeCache.url === url && Date.now() - probeCache.at < statusTtl()) return probeCache.value;
  const b = searxngBackend();
  const value = b ? await b.probe() : { reachable: false, error: "SearXNG URL not set" };
  probeCache = { at: Date.now(), url, value };
  return value;
}

/** Status of all three options for the UI and GET /search/status. Never includes keys. */
export async function searchStatus(): Promise<Record<string, unknown>> {
  const cfg = getSearchConfig();
  const host = cfg.searxngUrl ? searxngHost(cfg.searxngUrl) : null;

  const sx = modeUsable("searxng", cfg);
  const probe: { reachable: boolean; error?: string } = cfg.searxngUrl ? await searxngProbeCached(cfg.searxngUrl) : { reachable: false };
  const searxng = {
    id: "searxng",
    configured: sx.usable,
    reachable: probe.reachable,
    state: !sx.usable ? "disabled" : probe.reachable && !probe.error ? "ok" : "error",
    ...(sx.usable && probe.error ? { lastError: String(probe.error).replace(/https?:\/\/[^\s"'<>]+/gi, "[url]") } : {}),
    ...(host ? { host } : {}),
  };

  const group = (g: EngineGroupId) => {
    const u = modeUsable(g, cfg);
    const engines: EngineStatus[] = aggregator.status(g).engines;
    const live = engines.filter((e) => e.enabled && e.state !== "disabled");
    const failing = (e: EngineStatus) => e.state === "error" || e.state === "cooldown";
    const state = !u.usable ? "disabled" : live.length > 0 && live.every(failing) ? "error" : "ok";
    const lastError = engines.find((e) => failing(e) && e.lastError)?.lastError;
    return { id: g, configured: u.usable, reachable: true, state, ...(lastError ? { lastError } : {}), engines };
  };
  const builtin = group("builtin");
  const api = group("api");

  const active: SearchMode | null = modeUsable(cfg.mode, cfg).usable
    ? cfg.mode
    : cfg.fallback ? (FALLBACK_ORDER.find((m) => modeUsable(m, cfg).usable) ?? null) : null;
  const reachable = active === "searxng" ? searxng.reachable : active !== null;
  const engines = active === "builtin" ? builtin.engines : active === "api" ? api.engines : undefined;
  const lastUsed = lastSearchInfo();

  return {
    configured: active !== null,
    backend: active,
    active,
    mode: cfg.mode,
    fallback: cfg.fallback,
    ...(host ? { host } : {}),
    reachable,
    ...(active === "searxng" && (searxng as any).lastError ? { error: (searxng as any).lastError } : {}),
    options: [searxng, builtin, api],
    ...(engines ? { engines } : {}),
    ...(lastUsed ? { lastUsed } : {}),
  };
}
