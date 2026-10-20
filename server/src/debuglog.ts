import { db, getMessageRow } from "./db.js";
import { decryptSecret } from "./secret.js";

export const DEBUG_CAP = 256 * 1024;

export interface DebugRecord {
  model: string;
  providerKind: string;
  final: {
    messages: { role: string; content: string }[];
    params: Record<string, unknown>;
    effort: { requested: string | null; resolved: string | null; sentAs: unknown };
    contextAction?: unknown;
    /** structured output requested for this reply (resolved one-shot > conversation) */
    responseFormat?: unknown;
    /** tool calling: tools offered, rounds used and a compact trace of the calls */
    tools?: { mode: string; offered: string[]; rounds: number; calls: { name: string; status: string; durationMs?: number; error?: string }[]; fellBackToAlways?: boolean };
    /** server-side search: mode, query actually used, whether results were injected, sources count, error */
    search?: { mode: string; query?: string; injected: boolean; sources: number; error?: string };
  };
  response: { status: number | string | null; finishReason?: string | null; usage?: unknown; timings?: unknown; raw?: unknown; logprobs?: unknown };
  createdAt: number;
}

const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");

/** Shrink a record until its JSON fits DEBUG_CAP: raw first, then message contents. */
export function capDebug(rec: DebugRecord): DebugRecord {
  // logprobs have their own cap (256 KB, applied while collecting) and do not count against the record cap
  const lp = rec.response?.logprobs;
  if (lp !== undefined) {
    const { logprobs: _l, ...rest } = rec.response;
    const capped = capDebug({ ...rec, response: rest });
    return { ...capped, response: { ...capped.response, logprobs: lp } };
  }
  if (size(rec) <= DEBUG_CAP) return rec;
  const r: DebugRecord = JSON.parse(JSON.stringify(rec));
  if (r.response.raw !== undefined) r.response.raw = { truncated: true };
  let limit = 50_000;
  while (size(r) > DEBUG_CAP && limit >= 100) {
    for (const m of r.final.messages) if (m.content.length > limit) m.content = m.content.slice(0, limit) + "...[truncated]";
    limit = Math.floor(limit / 2);
  }
  if (size(r) > DEBUG_CAP) r.final.messages = r.final.messages.slice(-4);
  return r;
}

export function saveDebug(messageId: string, rec: DebugRecord): void {
  db.prepare("UPDATE messages SET debug = ? WHERE id = ?").run(JSON.stringify(capDebug(rec)), messageId);
}

/** Returns the stored record, or undefined if none. Does not check ownership. */
export function loadDebug(messageId: string): DebugRecord | undefined {
  const r = getMessageRow(messageId);
  if (!r || typeof r.debug !== "string" || !r.debug) return undefined;
  try { return JSON.parse(r.debug); } catch { return undefined; }
}

/** One-off (flag in server_settings): debug records saved before borrowers' upstream errors were scrubbed could hold the owner's
 *  URL / key; scrub them for messages of users who borrowed a provider they do not own. */
export function scrubOldBorrowerDebug(): number {
  const KEY = "debug_scrub_v1";
  if (db.prepare("SELECT 1 FROM server_settings WHERE key = ?").get(KEY)) return 0;
  let n = 0;
  const rows = db.prepare(
    `SELECT m.id AS id, m.debug AS debug, p.base_url AS base_url, p.api_key AS api_key
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN providers p ON p.id = c.provider_id
      WHERE m.debug IS NOT NULL AND m.debug <> '' AND p.user_id <> m.user_id`,
  ).all() as { id: string; debug: string; base_url: string; api_key: string }[];
  const upd = db.prepare("UPDATE messages SET debug = ? WHERE id = ?");
  for (const r of rows) {
    let out = r.debug;
    if (r.base_url) out = out.split(String(r.base_url)).join("[url]");
    let key = "";
    try { key = decryptSecret(r.api_key); } catch { key = ""; }
    if (key) out = out.split(key).join("[key]");
    if (out !== r.debug) { upd.run(out, r.id); n++; }
  }
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)").run(KEY, "1", Date.now());
  return n;
}
