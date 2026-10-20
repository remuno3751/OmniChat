import type { SearchResult } from "../index.js";
import { engineFetch, withQuery } from "./http.js";
import type { EngineDef } from "./types.js";
import { makeResult, searchLang } from "./util.js";

/** Converts a MediaWiki list=search response into results on the language's wikipedia host. */
export function parseWikipedia(j: any, lang: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of Array.isArray(j?.query?.search) ? j.query.search : []) {
    if (typeof r?.title !== "string" || !r.title.trim()) continue;
    const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.trim().replace(/ /g, "_"))}`;
    const res = makeResult(r.title, url, r.snippet);
    if (res) out.push(res);
    if (out.length >= limit) break;
  }
  return out;
}

export const wikipedia: EngineDef = {
  id: "wikipedia",
  label: "Wikipedia",
  defaultOn: true,
  group: "builtin",
  async search(query, { limit, signal }) {
    // SEARCH_LANG first (default ja), then en; the second language is only queried when the first gave too few results.
    const langs = [...new Set([searchLang(), "en"])];
    const out: SearchResult[] = [];
    const seen = new Set<string>();
    let firstError: unknown;
    let answered = 0;
    for (const lang of langs) {
      if (out.length >= limit) break;
      let j: any;
      try {
        const text = await engineFetch(
          "wikipedia",
          `https://${lang}.wikipedia.org`,
          (base) => withQuery(base, "/w/api.php", {
            action: "query", list: "search", srsearch: query, srlimit: String(limit),
            srprop: "snippet", format: "json", utf8: "1",
          }),
          { headers: { Accept: "application/json" } },
          signal,
        );
        j = JSON.parse(text);
      } catch (e) {
        if (signal?.aborted) throw e;
        firstError ??= e;
        continue;
      }
      answered++;
      for (const r of parseWikipedia(j, lang, limit - out.length)) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
      }
    }
    if (!answered && firstError) throw firstError;
    return out;
  },
};
