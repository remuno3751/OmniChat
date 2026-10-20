import type { SearchResult } from "../index.js";
import { engineApiKey } from "../config.js";
import { engineFetch, withQuery } from "./http.js";
import type { EngineDef } from "./types.js";
import { makeResult } from "./util.js";

export const brave: EngineDef = {
  id: "brave",
  label: "Brave Search API",
  defaultOn: false,
  group: "api",
  keyEnv: "BRAVE_API_KEY",
  async search(query, { limit, signal }): Promise<SearchResult[]> {
    const key = engineApiKey("BRAVE_API_KEY");
    if (!key) throw new Error("brave: API key not set");
    const text = await engineFetch(
      "brave",
      "https://api.search.brave.com",
      (base) => withQuery(base, "/res/v1/web/search", { q: query, count: String(Math.min(limit, 20)) }),
      { headers: { Accept: "application/json", "X-Subscription-Token": key } },
      signal,
    );
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error("brave returned invalid JSON"); }
    const out: SearchResult[] = [];
    for (const r of Array.isArray(j?.web?.results) ? j.web.results : []) {
      const res = makeResult(r?.title, r?.url, r?.description);
      if (res) out.push(res);
      if (out.length >= limit) break;
    }
    return out;
  },
};
