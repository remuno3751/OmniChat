import { SEARCH_MODES, secretValues, type SearchMode } from "./search/config.js";
import { searchMaxResults, searchStatus, searchWithFallback } from "./search/index.js";

/** Replaces any configured API key that appears in an error text (keys are never returned). */
function scrub(text: string): string {
  let out = text;
  for (const v of secretValues()) out = out.split(v).join("***");
  return out;
}

/**
 * Shared body of POST /search/test and POST /local-admin/search/test. `mode` (optional) runs just that option, without
 * fallback; omitted runs the configured mode with the usual fallback. Returns the HTTP status and JSON body to send.
 */
export async function runSearchTest(body: any): Promise<{ status: number; body: object }> {
  const b = body && typeof body === "object" ? body : {};
  const q = b.query;
  if (typeof q !== "string" || !q.trim()) return { status: 400, body: { error: "query is required" } };
  if (b.mode !== undefined && !SEARCH_MODES.includes(b.mode)) return { status: 400, body: { error: "mode must be searxng, builtin or api" } };
  const mode = b.mode as SearchMode | undefined;
  try {
    const out = await searchWithFallback(q.trim().slice(0, 400), { limit: searchMaxResults() }, mode);
    return {
      status: 200,
      body: { results: out.results, usedBackend: out.usedBackend, tried: out.tried, status: await searchStatus() },
    };
  } catch (e: any) {
    return { status: 502, body: { error: scrub(String(e?.message ?? e)), status: await searchStatus() } };
  }
}
