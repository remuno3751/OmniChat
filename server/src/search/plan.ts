/* Search planning: let a model write the search query (and decide whether to search), and drop results that have nothing to do with it. */

import { needsFreshInfo } from "../freshness.js";

/** One short non-streamed completion; throws on failure. */
export type AskFn = (system: string, user: string, o?: { maxTokens?: number }) => Promise<string>;

export interface PlanResult {
  search: boolean;
  query: string;
  /** "model" = the model wrote it; "fallback" = the user's own words (the model failed or returned nothing usable) */
  source: "model" | "fallback";
}

const PLAN_SYSTEM = `You write web search queries for an assistant.
Read the conversation and the user's latest message, then answer with ONE JSON object and nothing else:
{"search": true or false, "query": "<search query>"}
Rules for "query":
- A short keyword query (at most 12 words), not a sentence. Remove politeness and filler.
- Keep proper nouns, product and model names, versions and numbers EXACTLY as written (for example Qwen3.6-35B-A3B).
- Resolve pronouns and references ("it", "that", "the previous one") from the conversation.
- Use the user's language, except when English finds better sources (programming, hardware, AI models, international news): then use English.
- If the message needs the newest information, include the year or the word "latest" only when it helps.
Rules for "search": true when the answer depends on facts after your training data, prices, news, releases, documentation, or things you cannot know. false for chit-chat, pure writing/translation/math/coding help, or questions about this conversation itself.`;

const FORCED_NOTE = '\nThe search is already decided: always answer with "search": true.';

const clean = (q: string): string =>
  q.replace(/^\s*(search(?: query)?|query|検索(?:語|クエリ)?)\s*[:：]\s*/i, "").replace(/^["'`「『“]+|["'`」』”]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

/** First balanced {...} in a model reply (models like to wrap JSON in prose or code fences). */
function firstJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/gi, "");
  for (let i = t.indexOf("{"); i >= 0; i = t.indexOf("{", i + 1)) {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      if (t[j] === "{") depth++;
      else if (t[j] === "}" && --depth === 0) {
        try { const v = JSON.parse(t.slice(i, j + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* try the next brace */ }
        break;
      }
    }
  }
  return null;
}

/** The user's words as a query: whitespace collapsed, 200 chars (what a search was always given before the model wrote the query). */
export const rawQuery = (latest: string): string => latest.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Asks the model for the query. `decide` = the model may also say "no search" (smart mode); otherwise the search is forced (always mode).
 * Never throws: on any failure the user's own words are used and, when deciding, the old keyword heuristic decides.
 */
export async function planSearch(
  ask: AskFn | null, history: { role: string; content: string }[], latest: string, decide: boolean,
): Promise<PlanResult> {
  const fallback: PlanResult = { search: decide ? needsFreshInfo(latest) : true, query: rawQuery(latest), source: "fallback" };
  if (!ask || !latest.trim()) return fallback;
  const convo = history.slice(-6).map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  let reply: string;
  try {
    reply = await ask(PLAN_SYSTEM + (decide ? "" : FORCED_NOTE), `${convo ? `Conversation so far:\n${convo}\n\n` : ""}Latest user message:\n${latest.replace(/\s+/g, " ").slice(0, 800)}`, { maxTokens: 400 });
  } catch { return fallback; }
  const j = firstJson(reply);
  if (j) {
    const query = typeof j.query === "string" ? clean(j.query) : "";
    const search = decide ? j.search !== false : true;
    if (!search) return { search: false, query: "", source: "model" };
    if (query) return { search: true, query, source: "model" };
    return fallback;
  }
  // not JSON: a bare one-line query is still usable
  const line = clean(reply.split("\n").find((l) => l.trim()) ?? "");
  return line && line.length <= 120 ? { search: true, query: line, source: "model" } : fallback;
}

/* ---------------- relevance ---------------- */

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "how", "what", "why", "with", "from", "by", "at", "as", "it", "this", "that", "about", "latest", "new", "news", "2024", "2025", "2026", "2027"]);

/** Search terms of a query: lower-case words (kept whole when they carry digits / hyphens / dots, e.g. "qwen3.6-35b-a3b") and CJK character pairs. */
export function queryTerms(q: string): string[] {
  const out = new Set<string>();
  const s = q.normalize("NFKC").toLowerCase();
  for (const w of s.split(/[^\p{L}\p{N}._+#-]+/u)) {
    if (!w) continue;
    if (/[぀-ヿ㐀-鿿]/.test(w)) {
      const cjk = w.replace(/[^぀-ヿ㐀-鿿]/g, "");
      for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
      const latin = w.match(/[a-z0-9][a-z0-9._+#-]*/g) ?? [];
      for (const l of latin) if (l.length >= 2 && !STOP.has(l)) out.add(l);
    } else if (w.length >= 2 && !STOP.has(w)) out.add(w.replace(/^[._+#-]+|[._+#-]+$/g, ""));
  }
  out.delete("");
  return [...out];
}

export interface Judgeable { title: string; url: string; snippet?: string }

/**
 * Light relevance check (no model call): a result stays when its title, snippet or host shares at least one term with the query.
 * Compound terms like "qwen3.6-35b-a3b" also match their parts. Returns the kept results in order; `dropped` counts the rest.
 */
export function filterRelevant<T extends Judgeable>(query: string, results: T[]): { kept: T[]; dropped: number } {
  const terms = queryTerms(query);
  if (terms.length === 0) return { kept: results, dropped: 0 };
  const parts = new Set<string>();
  for (const t of terms) for (const p of t.split(/[-._+]/)) if (p.length >= 3 && !STOP.has(p)) parts.add(p);
  const kept = results.filter((r) => {
    let host = "";
    try { host = new URL(r.url).hostname; } catch { /* keep going without the host */ }
    const hay = `${r.title} ${r.snippet ?? ""} ${host}`.normalize("NFKC").toLowerCase();
    return terms.some((t) => hay.includes(t)) || [...parts].some((p) => hay.includes(p));
  });
  return { kept, dropped: results.length - kept.length };
}
