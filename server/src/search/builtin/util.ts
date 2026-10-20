import type { SearchResult } from "../index.js";

export const SNIPPET_MAX = 400;
const TITLE_MAX = 300;

/** Decodes the common HTML/XML entities in one pass (so `&amp;lt;` becomes `&lt;`, not `<`). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    const code = (n: number) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
    if (lower.startsWith("#x")) return code(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return code(parseInt(lower.slice(1), 10));
    switch (lower) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      case "nbsp": return " ";
    }
    return m;
  });
}

/** Removes tags, decodes entities and collapses whitespace. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Unwraps XML CDATA sections. */
export function unCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Returns the URL when it is an absolute http(s) URL, otherwise null. */
export function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Builds a clean result, or null when the URL is not http(s). */
export function makeResult(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  if (typeof url !== "string") return null;
  const u = httpUrl(decodeEntities(url).trim());
  if (!u) return null;
  const t = typeof title === "string" ? stripTags(title) : "";
  const sn = typeof snippet === "string" ? stripTags(snippet).slice(0, SNIPPET_MAX) : "";
  return {
    title: (t || u).slice(0, TITLE_MAX),
    url: u,
    ...(sn ? { snippet: sn } : {}),
  };
}

/** SEARCH_LANG primary language subtag (default "ja"). */
export function searchLang(): string {
  const v = (process.env.SEARCH_LANG ?? "ja").trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(v) ? v : "ja";
}
