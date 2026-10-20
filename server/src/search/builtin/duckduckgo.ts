import type { SearchResult } from "../index.js";
import { EngineBlockedError, engineFetch, looksBlocked, withQuery } from "./http.js";
import type { EngineDef } from "./types.js";
import { decodeEntities, makeResult } from "./util.js";

const attr = (attrs: string, name: string): string | undefined => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
};

/** DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<real url>. */
function resolveDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    if (real) return real;
    if (u.hostname.endsWith("duckduckgo.com")) return "";
    return u.href;
  } catch {
    return "";
  }
}

/** Parses the html.duckduckgo.com result page (result__a links, result__snippet texts). */
export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const links: Array<{ index: number; href: string; title: string; end: number }> = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    if (!/class="[^"]*\bresult__a\b/i.test(attrs)) continue;
    const href = attr(attrs, "href");
    if (!href) continue;
    links.push({ index: m.index ?? 0, href: decodeEntities(href), title: m[2], end: (m.index ?? 0) + m[0].length });
  }
  const snippets = [...html.matchAll(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/gi)]
    .map((m) => ({ index: m.index ?? 0, text: m[1] }));

  const out: SearchResult[] = [];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const l = links[i];
    const next = links[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const sn = snippets.find((s) => s.index >= l.end && s.index < next);
    const r = makeResult(l.title, resolveDdgUrl(l.href), sn?.text);
    if (r) out.push(r);
  }
  return out;
}

export const duckduckgo: EngineDef = {
  id: "duckduckgo",
  label: "DuckDuckGo (HTML)",
  defaultOn: true,
  group: "builtin",
  async search(query, { limit, signal }) {
    const body = new URLSearchParams({ q: query }).toString();
    const text = await engineFetch(
      "duckduckgo",
      "https://html.duckduckgo.com",
      (base) => withQuery(base, "/html/"),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body,
        html: true,
      },
      signal,
    );
    const results = parseDuckDuckGo(text, limit);
    if (!results.length && (text.trim() === "" || looksBlocked(text))) {
      throw new EngineBlockedError("duckduckgo blocked the request (CAPTCHA or anomaly page)");
    }
    return results;
  },
};
