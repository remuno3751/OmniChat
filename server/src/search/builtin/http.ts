import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretValues } from "../config.js";

/** Thrown when an engine is blocked (CAPTCHA, anomaly page, 403/429/503). Counts as a failure. */
export class EngineBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineBlockedError";
  }
}

export const ENGINE_BODY_CAP = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 6000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const BLOCK_MARKERS = ["captcha", "unusual traffic", "anomaly"];

const userAgent = (() => {
  let version = "0";
  try {
    // src/search/builtin/http.ts (or dist/...) -> server/package.json
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    version = JSON.parse(readFileSync(p, "utf8")).version || "0";
  } catch { /* keep "0" */ }
  return `OmniChat/${version} (+https://github.com/remuno3751/omnichat)`;
})();

export const engineTimeoutMs = (): number => {
  const n = Number(process.env.SEARCH_ENGINE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
};

/** Env name of the base-URL override for an engine, e.g. bing-rss -> OMNICHAT_SEARCH_BASE_BING_RSS. */
export function engineBaseEnv(engineId: string): string {
  return `OMNICHAT_SEARCH_BASE_${engineId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Removes any API key value (env or stored, see config.ts secretValues) from a message before it is stored or shown. */
export function scrub(msg: string): string {
  let out = msg;
  for (const k of ["BRAVE_API_KEY", "TAVILY_API_KEY"]) {
    const v = process.env[k]?.trim();
    if (v && v.length >= 6) out = out.split(v).join("***");
  }
  for (const v of secretValues()) out = out.split(v).join("***");
  return out;
}

/** True when a page body looks like a CAPTCHA / anomaly / block page. */
export function looksBlocked(text: string): boolean {
  const t = text.toLowerCase();
  return BLOCK_MARKERS.some((m) => t.includes(m));
}

/** Base URL for an engine: the default (https only) or a loopback override from the environment. */
export function resolveBase(engineId: string, defaultBase: string): URL {
  const envName = engineBaseEnv(engineId);
  const override = process.env[envName]?.trim();
  if (override) {
    let u: URL;
    try { u = new URL(override); } catch { throw new Error(`${envName} is not a valid URL`); }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.has(u.hostname)) {
      throw new Error(`${envName} must be a loopback http(s) URL`);
    }
    return u;
  }
  const u = new URL(defaultBase);
  if (u.protocol !== "https:") throw new Error(`${engineId}: default base must be https`);
  return u;
}

/** Returns a copy of base with the given path (appended to any base path) and query parameters. */
export function withQuery(base: URL, path: string, params: Record<string, string> = {}): URL {
  const u = new URL(base.href);
  u.search = "";
  u.hash = "";
  u.pathname = base.pathname.replace(/\/+$/, "") + path;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

export interface EngineInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** HTML engine: HTTP 202 counts as a block (DuckDuckGo's anomaly response). */
  html?: boolean;
}

async function readCapped(res: Response, engineId: string, signal?: AbortSignal): Promise<string> {
  const tooLarge = () => new Error(`${engineId} response too large (over 1 MB)`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ENGINE_BODY_CAP) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(`${engineId} response read failed`);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > ENGINE_BODY_CAP) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The only way engines talk to the network. The request URL is built from the base (default https host, or a loopback
 * override), must keep the base's host, never follows redirects, has a timeout, a 1 MB body cap and a fixed User-Agent,
 * and sends no cookies. Keys travel in headers or the body only.
 */
export async function engineFetch(
  engineId: string,
  defaultBase: string,
  buildUrl: (base: URL) => URL,
  init: EngineInit = {},
  signal?: AbortSignal,
): Promise<string> {
  const base = resolveBase(engineId, defaultBase);
  const url = buildUrl(base);
  if (url.protocol !== base.protocol || url.host !== base.host) {
    throw new Error(`${engineId}: request host not allowed`);
  }
  const timeout = engineTimeoutMs();
  const sigs: AbortSignal[] = [AbortSignal.timeout(timeout)];
  if (signal) sigs.push(signal);
  const sig = AbortSignal.any(sigs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { "User-Agent": userAgent, ...(init.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      signal: sig,
    });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    if (e?.name === "TimeoutError") throw new Error(`${engineId} timed out after ${timeout} ms`);
    throw new Error(`${engineId} unreachable: ${scrub(String(e?.cause?.code ?? e?.message ?? e))}`);
  }

  if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${engineId}: redirect refused`);
  }
  if (res.status === 403 || res.status === 429 || res.status === 503 || (init.html && res.status === 202)) {
    await res.body?.cancel().catch(() => {});
    throw new EngineBlockedError(`${engineId} blocked or rate-limited the request (HTTP ${res.status})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${engineId} HTTP ${res.status}`);
  }
  return readCapped(res, engineId, signal);
}
