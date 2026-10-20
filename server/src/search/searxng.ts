import type { SearchBackend, SearchResult } from "./index.js";
import { getSearchConfig } from "./config.js";

const HTML_MSG = "SearXNG returned HTML: enable `search.formats: [html, json]` in its settings.yml";

const timeoutMs = (): number => {
  const n = Number(process.env.SEARXNG_TIMEOUT_MS ?? 8000);
  return Number.isFinite(n) && n > 0 ? n : 8000;
};

const looksHtml = (text: string, contentType: string): boolean =>
  /text\/html/i.test(contentType) || /^\s*(<!doctype html|<html)/i.test(text);

class SearxngBackend implements SearchBackend {
  readonly name = "searxng";
  readonly host: string;
  constructor(private readonly base: URL) { this.host = base.host; }

  private signal(extra?: AbortSignal): AbortSignal {
    const sigs = [AbortSignal.timeout(timeoutMs())];
    if (extra) sigs.push(extra);
    return AbortSignal.any(sigs);
  }

  private url(query: string, extra?: Record<string, string>): string {
    const u = new URL(this.base.href.replace(/\/+$/, "") + "/search");
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
    return u.href;
  }

  /**
   * Public engines get rate-limited / CAPTCHA'd often, which leaves SearXNG answering 200 with zero results. Try the configured
   * engines (SEARXNG_ENGINES) first, then the default set, then the news category, and report the failing engines when nothing works.
   */
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    const engines = (process.env.SEARXNG_ENGINES ?? "").trim();
    const attempts: Array<Record<string, string> | undefined> = [engines ? { engines } : undefined, ...(engines ? [undefined] : []), { categories: "news" }];
    let failing = "";
    for (const extra of attempts) {
      const r = await this.searchOnce(query, opts, extra);
      if (r.results.length) return r.results;
      if (r.failing) failing = r.failing;
    }
    if (failing) throw new Error(`SearXNG returned no results (engines failing: ${failing}). Enable other engines in its settings.yml or set SEARXNG_ENGINES.`);
    return [];
  }

  private async searchOnce(query: string, opts: { limit: number; signal?: AbortSignal }, extra?: Record<string, string>): Promise<{ results: SearchResult[]; failing: string }> {
    let res: Response;
    try {
      res = await fetch(this.url(query, extra),{ headers: { Accept: "application/json" }, signal: this.signal(opts.signal) });
    } catch (e: any) {
      if (opts.signal?.aborted) throw e;
      if (e?.name === "TimeoutError") throw new Error(`SearXNG timed out after ${timeoutMs()} ms`);
      throw new Error(`SearXNG unreachable (${this.host}): ${e?.cause?.code ?? e?.message ?? e}`);
    }
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    if (looksHtml(text, ct)) throw new Error(HTML_MSG);
    // SearXNG answers 403 when the requested format is not enabled.
    if (res.status === 403) throw new Error("SearXNG refused the request (HTTP 403): enable `search.formats: [html, json]` in its settings.yml");
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(HTML_MSG.replace("returned HTML", "did not return JSON")); }
    const out: SearchResult[] = [];
    for (const r of Array.isArray(j?.results) ? j.results : []) {
      if (!r || typeof r.url !== "string" || !r.url) continue;
      out.push({
        title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url,
        url: r.url,
        ...(typeof r.content === "string" && r.content.trim() ? { snippet: r.content.trim().slice(0, 400) } : {}),
      });
      if (out.length >= opts.limit) break;
    }
    const failing = (Array.isArray(j?.unresponsive_engines) ? j.unresponsive_engines : []).map((e: any) => (Array.isArray(e) ? e.join(": ") : String(e))).join("; ");
    return { results: out, failing };
  }

  async probe(signal?: AbortSignal): Promise<{ reachable: boolean; error?: string }> {
    try {
      const res = await fetch(this.url("test"), { headers: { Accept: "application/json" }, signal: this.signal(signal) });
      const text = await res.text();
      if (looksHtml(text, res.headers.get("content-type") ?? "") ) return { reachable: true, error: HTML_MSG };
      if (res.status === 403) return { reachable: true, error: "SearXNG refused the JSON format (HTTP 403): enable `search.formats: [html, json]`" };
      if (!res.ok) return { reachable: true, error: `SearXNG HTTP ${res.status}` };
      return { reachable: true };
    } catch (e: any) {
      return { reachable: false, error: e?.name === "TimeoutError" ? `timed out after ${timeoutMs()} ms` : String(e?.cause?.code ?? e?.message ?? e) };
    }
  }
}

/** The SearXNG backend for the configured URL (config.ts: DB value, else SEARXNG_URL), or null when unset or invalid. */
export function searxngBackend(): SearchBackend | null {
  const raw = getSearchConfig().searxngUrl;
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return new SearxngBackend(u);
  } catch { return null; }
}
