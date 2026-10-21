/* Token-usage analytics (GET /usage/*, see routes-usage.ts).
 *
 * Every number comes from one GROUP BY query over `metrics` (plus a LEFT JOIN to `providers` / `conversations` where a
 * name or title is needed). Ephemeral chats are excluded twice: the db.ts routing keeps their rows in the in-memory
 * `eph` schema, and the conversation_id guard below keeps any eph_ row out of the persistent store's results too.
 *
 * Time handling: every bucket is computed by offset arithmetic (`ms + tz * 60000`), never by the server's own zone.
 * Every exported query function takes an optional connection (defaults to the shared `db`) so tests can run it on a
 * temporary database. */
import type { DatabaseSync } from "node:sqlite";
import { db as sharedDb } from "./db.js";

export const DAY_MS = 86_400_000;
/** Largest window `/usage/daily` returns (also the cap for days=0 "all"). */
export const MAX_DAYS = 3660;
const TZ_LIMIT = 840;

/** `userId` null = every user (admin with scope=all). `from` inclusive, `to` exclusive (epoch ms). */
export interface UsageFilter {
  userId: string | null;
  from?: number | null;
  to?: number | null;
  conversationId?: string | null;
}

export interface Agg {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  messages: number;
  estimatedMessages: number;
}

// ---------- pure helpers ----------

/** Integer minutes east of UTC, truncated and clamped to [-840, 840]. Missing / non-numeric -> 0. */
export function clampTz(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(TZ_LIMIT, Math.max(-TZ_LIMIT, Math.trunc(n)));
}

/** Epoch-ms query value. Missing, empty or non-finite input is IGNORED (returns null), it is never a 400. */
export function parseMs(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Index of the local calendar day (days since 1970-01-01 in the zone tz minutes east of UTC). */
export function localDayIndex(ms: number, tz: number): number {
  return Math.floor((ms + tz * 60_000) / DAY_MS);
}

/** "YYYY-MM-DD" of a day index (the calendar date, zone-free). */
export function dayKey(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/** Inverse of dayKey for a "YYYY-MM-DD" string. */
export function dayIndexOfKey(key: string): number {
  return Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
}

/** Epoch ms of local midnight that starts the day index, in zone tz. */
export function dayStartMs(index: number, tz: number): number {
  return index * DAY_MS - tz * 60_000;
}

/** The `count` local days ending with (and including) endIndex, oldest first, zero-fill ready. */
export function dayBuckets(endIndex: number, count: number, tz: number): Array<{ day: string; start: number }> {
  const out: Array<{ day: string; start: number }> = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = endIndex - i;
    out.push({ day: dayKey(idx), start: dayStartMs(idx, tz) });
  }
  return out;
}

// ---------- SQL building blocks ----------

// The LIKE text is: conversation_id NOT LIKE 'eph\_%' ESCAPE '\'  (the backslash escapes the underscore).
const NOT_EPHEMERAL = "m.conversation_id NOT LIKE 'eph\\_%' ESCAPE '\\'";

function where(f: UsageFilter): { sql: string; params: Array<string | number> } {
  const parts = [NOT_EPHEMERAL];
  const params: Array<string | number> = [];
  if (f.userId !== null) { parts.push("m.user_id = ?"); params.push(f.userId); }
  if (f.from !== undefined && f.from !== null) { parts.push("m.created_at >= ?"); params.push(f.from); }
  if (f.to !== undefined && f.to !== null) { parts.push("m.created_at < ?"); params.push(f.to); }
  if (f.conversationId) { parts.push("m.conversation_id = ?"); params.push(f.conversationId); }
  return { sql: parts.join(" AND "), params };
}

/** Aggregate columns shared by every query. totalTokens = prompt + completion (reasoning is inside completion). */
const AGG_COLUMNS = `COALESCE(SUM(m.prompt_tokens), 0) AS promptTokens,
  COALESCE(SUM(m.completion_tokens), 0) AS completionTokens,
  COALESCE(SUM(m.reasoning_tokens), 0) AS reasoningTokens,
  (COALESCE(SUM(m.prompt_tokens), 0) + COALESCE(SUM(m.completion_tokens), 0)) AS totalTokens,
  COUNT(*) AS messages,
  COALESCE(SUM(CASE WHEN m.usage_exact = 0 THEN 1 ELSE 0 END), 0) AS estimatedMessages`;

type AggRow = Agg;

function toAgg(r: AggRow): Agg {
  return {
    promptTokens: Number(r.promptTokens), completionTokens: Number(r.completionTokens), reasoningTokens: Number(r.reasoningTokens),
    totalTokens: Number(r.totalTokens), messages: Number(r.messages), estimatedMessages: Number(r.estimatedMessages),
  };
}

// ---------- summary ----------

export interface UsageTotals extends Agg {
  chats: number;
  avgTokensPerAnswer: number;
}
export interface TopModel { providerId: string | null; providerName: string | null; model: string | null; totalTokens: number }

export interface SummaryResponse {
  from: number | null;
  to: number | null;
  tz: number;
  totals: UsageTotals;
  estimated: boolean;
  topModel: TopModel | null;
}

export function usageSummary(f: UsageFilter, tz: number, conn: DatabaseSync = sharedDb): SummaryResponse {
  const w = where(f);
  const row = conn.prepare(
    `SELECT ${AGG_COLUMNS}, COUNT(DISTINCT m.conversation_id) AS chats FROM metrics m WHERE ${w.sql}`,
  ).get(...w.params) as unknown as AggRow & { chats: number };
  const agg = toAgg(row);
  const chats = Number(row.chats);
  const models = usageModels(f, conn).models;
  const top = models[0];
  return {
    from: f.from ?? null,
    to: f.to ?? null,
    tz,
    totals: {
      ...agg,
      chats,
      avgTokensPerAnswer: agg.messages > 0 ? Math.round(agg.totalTokens / agg.messages) : 0,
    },
    estimated: agg.estimatedMessages > 0,
    topModel: top ? { providerId: top.providerId, providerName: top.providerName, model: top.model, totalTokens: top.totalTokens } : null,
  };
}

// ---------- daily ----------

export interface DailyBucket extends Agg { day: string; start: number }
export interface DailyResponse { tz: number; days: DailyBucket[]; estimated: boolean }

/**
 * `days` buckets ending with today (in zone tz). days=0 means "all": from the local day of the oldest row to today,
 * capped at MAX_DAYS. One GROUP BY by local day; the zero-fill happens in JS over the bucket list.
 */
export function usageDaily(
  opts: { userId: string | null; days: number; tz: number; now?: number },
  conn: DatabaseSync = sharedDb,
): DailyResponse {
  const { tz } = opts;
  const now = opts.now ?? Date.now();
  const todayIdx = localDayIndex(now, tz);
  const lower = opts.days > 0 ? dayStartMs(todayIdx - opts.days + 1, tz) : null;
  const w = where({ userId: opts.userId, from: lower });
  // the first ? is the tz offset applied before the day split; the rest belong to the WHERE clause
  const rows = conn.prepare(
    `SELECT strftime('%Y-%m-%d', (m.created_at + ?) / 1000, 'unixepoch') AS day, ${AGG_COLUMNS}
     FROM metrics m WHERE ${w.sql} GROUP BY day`,
  ).all(tz * 60_000, ...w.params) as unknown as Array<AggRow & { day: string }>;

  let count = opts.days;
  if (opts.days === 0) {
    if (rows.length === 0) return { tz, days: [], estimated: false };
    const first = Math.min(...rows.map((r) => dayIndexOfKey(r.day)));
    count = Math.min(MAX_DAYS, Math.max(1, todayIdx - first + 1));
  }
  const byDay = new Map(rows.map((r) => [r.day, toAgg(r)] as const));
  const days: DailyBucket[] = dayBuckets(todayIdx, count, tz).map((b) => ({
    day: b.day,
    start: b.start,
    ...(byDay.get(b.day) ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, messages: 0, estimatedMessages: 0 }),
  }));
  return { tz, days, estimated: days.some((d) => d.estimatedMessages > 0) };
}

// ---------- chats ----------

export interface ChatRow extends Agg { conversationId: string; title: string; models: string[]; lastActivity: number }
export interface ChatsResponse { chats: ChatRow[]; estimated: boolean }

/** Top chats by total tokens (ties: most recent first). Deleted conversations are excluded here only. */
export function usageChats(f: UsageFilter, limit: number, conn: DatabaseSync = sharedDb): ChatsResponse {
  const w = where(f);
  const rows = conn.prepare(
    `SELECT m.conversation_id AS conversationId, c.title AS title, MAX(m.created_at) AS lastActivity, ${AGG_COLUMNS}
     FROM metrics m JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id AND c.deleted = 0
     WHERE ${w.sql}
     GROUP BY m.conversation_id, c.title
     ORDER BY totalTokens DESC, lastActivity DESC
     LIMIT ?`,
  ).all(...w.params, limit) as unknown as Array<AggRow & { conversationId: string; title: string; lastActivity: number }>;

  // up to 3 models per chat, most-used first: one GROUP BY over just the listed chats
  const models = new Map<string, string[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.conversationId);
    const mr = conn.prepare(
      `SELECT m.conversation_id AS conversationId, m.model AS model, COUNT(*) AS n
       FROM metrics m
       WHERE ${w.sql} AND m.model IS NOT NULL AND m.conversation_id IN (${ids.map(() => "?").join(",")})
       GROUP BY m.conversation_id, m.model
       ORDER BY m.conversation_id, n DESC, m.model`,
    ).all(...w.params, ...ids) as Array<{ conversationId: string; model: string }>;
    for (const r of mr) {
      const list = models.get(r.conversationId) ?? [];
      if (list.length < 3) list.push(r.model);
      models.set(r.conversationId, list);
    }
  }
  const out: ChatRow[] = rows.map((r) => ({
    conversationId: r.conversationId,
    title: r.title,
    models: models.get(r.conversationId) ?? [],
    ...toAgg(r),
    lastActivity: Number(r.lastActivity),
  }));
  return { chats: out, estimated: out.some((c) => c.estimatedMessages > 0) };
}

// ---------- models ----------

export interface ModelRow extends Agg {
  providerId: string | null;
  providerName: string | null;
  providerKind: string | null;
  model: string | null;
  share: number;
}
export interface ModelsResponse { models: ModelRow[]; estimated: boolean }

/** Per provider + model totals, biggest first. share = totalTokens / grand total (0..1). */
export function usageModels(f: UsageFilter, conn: DatabaseSync = sharedDb): ModelsResponse {
  const w = where(f);
  const rows = conn.prepare(
    `SELECT m.provider_id AS providerId, MAX(pv.name) AS providerName, m.provider_kind AS providerKind, m.model AS model, ${AGG_COLUMNS}
     FROM metrics m LEFT JOIN providers pv ON pv.id = m.provider_id
     WHERE ${w.sql}
     GROUP BY m.provider_id, m.provider_kind, m.model
     ORDER BY totalTokens DESC, m.provider_id, m.model`,
  ).all(...w.params) as unknown as Array<AggRow & { providerId: string | null; providerName: string | null; providerKind: string | null; model: string | null }>;
  const grand = rows.reduce((s, r) => s + Number(r.totalTokens), 0);
  const models: ModelRow[] = rows.map((r) => ({
    providerId: r.providerId ?? null,
    providerName: r.providerName ?? null,
    providerKind: r.providerKind ?? null,
    model: r.model ?? null,
    ...toAgg(r),
    share: grand > 0 ? Number(r.totalTokens) / grand : 0,
  }));
  return { models, estimated: models.some((m) => m.estimatedMessages > 0) };
}

// ---------- per user (admin overview for the server app) ----------

/** One bucket of "active time": a 5-minute slot that holds at least one answer of the user. */
export const ACTIVE_SLOT_MS = 5 * 60_000;

export interface UserUsageRow extends Agg {
  userId: string;
  username: string;
  disabled: boolean;
  chats: number;
  /** distinct 5-minute slots with an answer x 5 minutes: a lower-bound estimate of the time spent chatting */
  activeMinutes: number;
  /** sum of the generation times (metrics.total_ms) */
  generationMs: number;
  /** distinct local days with an answer */
  activeDays: number;
  lastActivity: number | null;
}
export interface UsersUsageResponse {
  from: number | null;
  to: number | null;
  tz: number;
  users: UserUsageRow[];
  totals: Agg & { users: number; activeUsers: number; chats: number; activeMinutes: number; generationMs: number };
  estimated: boolean;
}

/** Every user (also those without answers), their tokens, active time and last activity. Ephemeral chats are not counted. */
export function usageByUser(f: { from?: number | null; to?: number | null }, tz: number, conn: DatabaseSync = sharedDb): UsersUsageResponse {
  const w = where({ userId: null, from: f.from ?? null, to: f.to ?? null });
  const rows = conn.prepare(
    `SELECT m.user_id AS userId, ${AGG_COLUMNS},
       COUNT(DISTINCT m.conversation_id) AS chats,
       COUNT(DISTINCT m.created_at / ${ACTIVE_SLOT_MS}) AS slots,
       COUNT(DISTINCT (m.created_at + ${tz} * 60000) / ${DAY_MS}) AS activeDays,
       COALESCE(SUM(m.total_ms), 0) AS generationMs,
       MAX(m.created_at) AS lastActivity
     FROM metrics m WHERE ${w.sql} GROUP BY m.user_id`,
  ).all(...w.params) as unknown as Array<AggRow & { userId: string; chats: number; slots: number; activeDays: number; generationMs: number; lastActivity: number }>;
  const byId = new Map(rows.map((r) => [r.userId, r]));
  const users = conn.prepare("SELECT id, username, disabled_at FROM users ORDER BY created_at, rowid").all() as unknown as Array<{ id: string; username: string; disabled_at: number | null }>;
  const out: UserUsageRow[] = users.map((u) => {
    const r = byId.get(u.id);
    const agg = r ? toAgg(r) : { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, messages: 0, estimatedMessages: 0 };
    return {
      userId: u.id, username: u.username, disabled: u.disabled_at != null, ...agg,
      chats: r ? Number(r.chats) : 0,
      activeMinutes: r ? Number(r.slots) * (ACTIVE_SLOT_MS / 60_000) : 0,
      generationMs: r ? Math.round(Number(r.generationMs)) : 0,
      activeDays: r ? Number(r.activeDays) : 0,
      lastActivity: r ? Number(r.lastActivity) : null,
    };
  });
  const sum = (k: keyof Agg) => out.reduce((a, u) => a + u[k], 0);
  const all = conn.prepare(`SELECT COUNT(DISTINCT m.conversation_id) AS chats, COUNT(DISTINCT m.user_id || ':' || (m.created_at / ${ACTIVE_SLOT_MS})) AS slots FROM metrics m WHERE ${w.sql}`).get(...w.params) as unknown as { chats: number; slots: number };
  const totals = {
    promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), reasoningTokens: sum("reasoningTokens"),
    totalTokens: sum("totalTokens"), messages: sum("messages"), estimatedMessages: sum("estimatedMessages"),
    users: out.length, activeUsers: out.filter((u) => u.messages > 0).length,
    chats: Number(all.chats), activeMinutes: Number(all.slots) * (ACTIVE_SLOT_MS / 60_000),
    generationMs: out.reduce((a, u) => a + u.generationMs, 0),
  };
  return { from: f.from ?? null, to: f.to ?? null, tz, users: out, totals, estimated: totals.estimatedMessages > 0 };
}
