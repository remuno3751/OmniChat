import type { SearchOpts, SearchResult } from "../index.js";
import { scrub } from "./http.js";
import { ENGINES, enabledEngineIds, keyIsSet, type EngineGroup } from "./table.js";
import type { EngineDef } from "./types.js";

const FAILS_BEFORE_COOLDOWN = 3;
const COOLDOWN_BASE_MS = 10 * 60_000;
const COOLDOWN_MAX_MS = 60 * 60_000;
const CACHE_MAX = 100;
const QUERY_MAX = 200;
const LIMIT_MAX = 20;

const cooldownBase = (): number => {
  const n = Number(process.env.OMNICHAT_SEARCH_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : COOLDOWN_BASE_MS;
};
const cacheTtl = (): number => {
  const n = Number(process.env.OMNICHAT_SEARCH_CACHE_TTL_MS ?? 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
};

interface Health {
  fails: number;
  /** Number of cooldowns started since the last success (drives the doubling). */
  level: number;
  cooldownUntil: number;
  lastError?: string;
  lastOkAt?: number;
}

export interface EngineStatus {
  id: string;
  label: string;
  enabled: boolean;
  state: "ok" | "cooldown" | "error" | "disabled";
  keySet?: boolean;
  lastError?: string;
  lastOkAt?: string;
}

export interface GroupStatus {
  engines: EngineStatus[];
}

/** Lower-cased host without www., no fragment, no trailing slash, no utm_* parameters. Used for de-duplication only. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const qs = u.searchParams.toString();
    return `${u.protocol.toLowerCase()}//${host}${u.port ? `:${u.port}` : ""}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw;
  }
}

/** Round-robin by rank across the per-engine lists (engine order), de-duplicated, trimmed to limit. */
export function mergeRoundRobin(lists: SearchResult[][], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < depth && out.length < limit; rank++) {
    for (const list of lists) {
      const r = list[rank];
      if (!r) continue;
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

const errorText = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return scrub(msg).replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
};

/**
 * Runs the enabled engines of one group ("builtin" or "api") in parallel and merges their results. Health (failures,
 * cooldowns) and the result cache are module-level state, so they survive the per-request backend objects.
 */
export class SearchAggregator {
  private health = new Map<string, Health>();
  private cache = new Map<string, { at: number; results: SearchResult[] }>();

  private h(id: string): Health {
    let x = this.health.get(id);
    if (!x) {
      x = { fails: 0, level: 0, cooldownUntil: 0 };
      this.health.set(id, x);
    }
    return x;
  }

  private onSuccess(id: string): void {
    const h = this.h(id);
    h.fails = 0;
    h.level = 0;
    h.cooldownUntil = 0;
    delete h.lastError;
    h.lastOkAt = Date.now();
  }

  private onFailure(id: string, reason: string): void {
    const h = this.h(id);
    h.fails++;
    h.lastError = reason;
    if (h.fails >= FAILS_BEFORE_COOLDOWN) {
      const base = cooldownBase();
      const ms = Math.min(base * 2 ** h.level, Math.max(base, COOLDOWN_MAX_MS));
      h.cooldownUntil = Date.now() + ms;
      h.level++;
    }
  }

  async search(query: string, opts: SearchOpts, group: EngineGroup): Promise<SearchResult[]> {
    const q = query.trim().slice(0, QUERY_MAX);
    const limit = Math.max(1, Math.min(opts.limit, LIMIT_MAX));
    if (!q) return [];
    const ids = enabledEngineIds(group);
    const key = `${group}\u0000${q}\u0000${limit}\u0000${ids.join(",")}`;

    const ttl = cacheTtl();
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < ttl) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        return hit.results.map((r) => ({ ...r }));
      }
    }

    const now = Date.now();
    const reason = new Map<string, string>();
    const runnable: EngineDef[] = [];
    for (const id of ids) {
      const def = ENGINES.find((e) => e.id === id);
      if (!def) continue;
      if (!keyIsSet(def)) {
        reason.set(id, "API key not set");
        continue;
      }
      const h = this.h(id);
      if (h.cooldownUntil > now) {
        const secs = Math.ceil((h.cooldownUntil - now) / 1000);
        reason.set(id, `cooling down after repeated errors, retry in ${secs} s${h.lastError ? ` (last error: ${h.lastError})` : ""}`);
        continue;
      }
      runnable.push(def);
    }
    if (!runnable.length) {
      const parts = ids.map((id) => `${id}: ${reason.get(id) ?? "not available"}`);
      throw new Error(`Web search failed (${parts.join("; ") || "no engines enabled"})`);
    }

    const settled = await Promise.allSettled(runnable.map((d) => d.search(q, { limit, signal: opts.signal })));
    // A caller abort is not an engine failure: rethrow before touching health.
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");

    const lists: SearchResult[][] = [];
    let failed = 0;
    settled.forEach((s, i) => {
      const id = runnable[i].id;
      if (s.status === "fulfilled") {
        this.onSuccess(id);
        lists.push(s.value);
      } else {
        failed++;
        const msg = errorText(s.reason);
        this.onFailure(id, msg);
        reason.set(id, msg);
        lists.push([]);
      }
    });

    if (failed === runnable.length && lists.every((l) => !l.length)) {
      const parts = ids.map((id) => `${id}: ${reason.get(id) ?? "not available"}`);
      throw new Error(`Web search failed (${parts.join("; ")})`);
    }

    const results = mergeRoundRobin(lists, limit);
    if (ttl > 0 && failed === 0) {
      this.cache.set(key, { at: Date.now(), results });
      if (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
    }
    return results.map((r) => ({ ...r }));
  }

  /** Per-engine state of one group for the status endpoint. Never includes key values. */
  status(group: EngineGroup): GroupStatus {
    const now = Date.now();
    const enabled = new Set(enabledEngineIds(group));
    const engines: EngineStatus[] = ENGINES.filter((def) => def.group === group).map((def) => {
      const on = enabled.has(def.id);
      const h = this.health.get(def.id);
      const keySet = def.keyEnv ? keyIsSet(def) : undefined;
      let state: EngineStatus["state"];
      let lastError: string | undefined;
      if (!on) {
        state = "disabled";
      } else if (def.keyEnv && !keySet) {
        state = "disabled";
        lastError = "API key not set";
      } else if (h && h.cooldownUntil > now) {
        state = "cooldown";
        lastError = h.lastError;
      } else if (h && h.fails > 0) {
        state = "error";
        lastError = h.lastError;
      } else {
        state = "ok";
      }
      const e: EngineStatus = { id: def.id, label: def.label, enabled: on, state };
      if (keySet !== undefined) e.keySet = keySet;
      if (lastError) e.lastError = lastError;
      if (h?.lastOkAt) e.lastOkAt = new Date(h.lastOkAt).toISOString();
      return e;
    });
    return { engines };
  }
}

export const aggregator = new SearchAggregator();
