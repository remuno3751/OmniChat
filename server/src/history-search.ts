import { db } from "./db.js";

export interface HistoryHit {
  messageId: string | null; conversationId: string; conversationTitle: string; projectId: string | null;
  role: "user" | "assistant" | null; snippet: string; createdAt: number;
}
export interface HistoryResult { results: HistoryHit[]; total: number }

const MAX_QUERY = 200;
const MAX_TOKENS = 8;
const SNIPPET = 160;
const cpLen = (s: string) => [...s].length;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "trigram" or "unicode61" (fallback when the SQLite build has no trigram tokenizer). */
export function ftsTokenizer(): string {
  const r = db.prepare("SELECT v FROM fts_meta WHERE k = 'tokenizer'").get() as { v: string } | undefined;
  return r?.v ?? "trigram";
}

/** Whitespace separated terms (control chars removed, deduplicated, bounded). FTS syntax never reaches SQLite unquoted. */
export function parseTerms(q: string): string[] {
  const clean = q.slice(0, MAX_QUERY).replace(/[\u0000-\u001f]/g, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of clean.split(/\s+/)) {
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** ~160 chars around the first hit; every hit wrapped in \u0001 ... \u0002. */
export function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const re = new RegExp(terms.map(reEsc).sort((a, b) => b.length - a.length).join("|"), "giu");
  const first = flat.search(re);
  let start = 0;
  if (first > 60) start = first - 60;
  let end = Math.min(flat.length, start + SNIPPET);
  // do not split surrogate pairs
  if (start > 0 && /[\udc00-\udfff]/.test(flat[start] ?? "")) start++;
  if (end < flat.length && /[\ud800-\udbff]/.test(flat[end - 1] ?? "")) end--;
  const win = flat.slice(start, end);
  const marked = win.replace(re, (m) => (m ? `\u0001${m}\u0002` : m));
  return (start > 0 ? "…" : "") + marked + (end < flat.length ? "…" : "");
}

export function searchHistory(
  userId: string, q: string, opts: { projectId?: string | null; limit?: number; offset?: number } = {},
): HistoryResult {
  const terms = parseTerms(q);
  if (!terms.length) return { results: [], total: 0 };
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 20) || 20));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0) || 0);
  const trigram = ftsTokenizer() === "trigram";
  const longTerms = trigram ? terms.filter((t) => cpLen(t) >= 3) : [];
  const likeTerms = terms.filter((t) => !longTerms.includes(t));
  const match = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");

  const proj = opts.projectId ? " AND c.project_id = ?" : "";
  const part = (kind: "m" | "c"): { sql: string; args: (string | number)[] } => {
    const col = kind === "m" ? "m.content" : "c.title";
    const args: (string | number)[] = [];
    let from: string; let where: string;
    if (match) {
      from = kind === "m"
        ? "fts_history JOIN fts_map mp ON mp.fid = fts_history.rowid AND mp.kind = 'm' JOIN messages m ON m.id = mp.id JOIN conversations c ON c.id = m.conversation_id"
        : "fts_history JOIN fts_map mp ON mp.fid = fts_history.rowid AND mp.kind = 'c' JOIN conversations c ON c.id = mp.id";
      where = "fts_history MATCH ?";
      args.push(match);
    } else {
      from = kind === "m" ? "messages m JOIN conversations c ON c.id = m.conversation_id" : "conversations c";
      where = "1 = 1";
    }
    where += " AND c.user_id = ? AND c.deleted = 0" + proj;
    args.push(userId);
    if (opts.projectId) args.push(opts.projectId);
    for (const t of likeTerms) { where += ` AND ${col} LIKE ? ESCAPE '\\'`; args.push(`%${likeEsc(t)}%`); }
    const sel = kind === "m"
      ? "m.id AS mid, c.id AS cid, c.title AS ctitle, c.project_id AS pid, m.role AS role, m.created_at AS ts"
      : "NULL AS mid, c.id AS cid, c.title AS ctitle, c.project_id AS pid, NULL AS role, c.updated_at AS ts";
    return { sql: `SELECT ${sel} FROM ${from} WHERE ${where}`, args };
  };
  const pm = part("m"), pc = part("c");
  const union = `${pm.sql} UNION ALL ${pc.sql}`;
  const args = [...pm.args, ...pc.args];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...args) as { n: number }).n;
  const rows = db.prepare(`${union} ORDER BY ts DESC, mid LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  const getContent = db.prepare("SELECT content FROM messages WHERE id = ?");
  const results = rows.map((r): HistoryHit => {
    const text = r.mid ? ((getContent.get(r.mid) as any)?.content ?? "") : r.ctitle;
    return {
      messageId: r.mid ?? null, conversationId: r.cid, conversationTitle: r.ctitle, projectId: r.pid ?? null,
      role: r.role === "user" || r.role === "assistant" ? r.role : null,
      snippet: makeSnippet(text, terms), createdAt: r.ts,
    };
  });
  return { results, total };
}
