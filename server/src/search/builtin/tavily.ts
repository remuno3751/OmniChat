import type { SearchResult } from "../index.js";
import { engineApiKey } from "../config.js";
import { engineFetch } from "./http.js";
import type { EngineDef } from "./types.js";
import { makeResult } from "./util.js";

export const tavily: EngineDef = {
  id: "tavily",
  label: "Tavily Search API",
  defaultOn: false,
  group: "api",
  keyEnv: "TAVILY_API_KEY",
  async search(query, { limit, signal }): Promise<SearchResult[]> {
    const key = engineApiKey("TAVILY_API_KEY");
    if (!key) throw new Error("tavily: API key not set");
    const text = await engineFetch(
      "tavily",
      "https://api.tavily.com",
      (base) => new URL(`${base.pathname.replace(/\/+$/, "")}/search`, base),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: Math.min(limit, 20) }),
      },
      signal,
    );
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error("tavily returned invalid JSON"); }
    const out: SearchResult[] = [];
    for (const r of Array.isArray(j?.results) ? j.results : []) {
      const res = makeResult(r?.title, r?.url, r?.content);
      if (res) out.push(res);
      if (out.length >= limit) break;
    }
    return out;
  },
};
