import type { SearchResult } from "../index.js";
import { engineFetch, withQuery } from "./http.js";
import type { EngineDef } from "./types.js";
import { makeResult, searchLang, unCdata } from "./util.js";

/** Parses Bing's RSS search feed (<item><title/><link/><description/>). */
export function parseBingRss(xml: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const field = (name: string): string | undefined => {
      const f = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
      return f ? unCdata(f[1]) : undefined;
    };
    const r = makeResult(field("title"), field("link"), field("description"));
    if (r) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export const bingRss: EngineDef = {
  id: "bing-rss",
  label: "Bing (RSS)",
  defaultOn: true,
  group: "builtin",
  async search(query, { limit, signal }) {
    const mkt = searchLang() === "ja" ? "ja-JP" : "en-US";
    const text = await engineFetch(
      "bing-rss",
      "https://www.bing.com",
      (base) => withQuery(base, "/search", { format: "rss", q: query, mkt }),
      { headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } },
      signal,
    );
    return parseBingRss(text, limit);
  },
};
