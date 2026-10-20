/* Usage quotas for shared providers (docs/PROTOCOL-v7-quotas.md). Only shared-provider models used by non-admin users are counted and
   limited. Defaults are server_settings key "quotas" (same pattern as attachments-settings.ts); per-user overrides are table user_quotas;
   usage is table quota_usage (one row per user and local day). Imports only db, auth, admin-core and shared-providers. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { recordAudit, requireAdminUser, checkRate, type Actor } from "./admin-core.js";
import { isAdminUser, listSharedProvidersFor } from "./shared-providers.js";

export interface QuotaSettings {
  /** master switch: false = nothing is limited (usage is still counted) */
  enabled: boolean;
  /** tokens per local day for every user; 0 = unlimited */
  dailyTokens: number;
  /** tokens per local calendar month; 0 = unlimited */
  monthlyTokens: number;
}

export const QUOTA_DEFAULTS: QuotaSettings = { enabled: false, dailyTokens: 0, monthlyTokens: 0 };
export const QUOTA_MAX = 1_000_000_000_000;
/** Usage rows older than this many days are deleted. */
export const QUOTA_KEEP_DAYS = 400;

const KEY = "quotas";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A per-user override. null = follow the default; 0 = unlimited for this user. */
export interface UserQuota { dailyTokens: number | null; monthlyTokens: number | null }

const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD in server local time. */
export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** First day of the local month containing `now`, YYYY-MM-DD. */
const monthStartDay = (now: number): string => {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
/** The next local midnight after `now` (the daily reset), ISO string. */
export function nextDayReset(now: number): string {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
}
/** The first local midnight of the next month after `now` (the monthly reset), ISO string. */
export function nextMonthReset(now: number): string {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
}

/* ---------------- settings ---------------- */

function readStored(): Record<string, unknown> {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

const isLimit = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= QUOTA_MAX;

/** The effective defaults: stored values that pass validation, else the defaults. */
export function readQuotaSettings(): QuotaSettings {
  const s = readStored();
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : QUOTA_DEFAULTS.enabled,
    dailyTokens: isLimit(s.dailyTokens) ? s.dailyTokens : QUOTA_DEFAULTS.dailyTokens,
    monthlyTokens: isLimit(s.monthlyTokens) ? s.monthlyTokens : QUOTA_DEFAULTS.monthlyTokens,
  };
}

/** PUT /admin/quotas body: partial and strict. Throws AuthError(400) on any problem. */
export function parseQuotaPatch(body: unknown): Partial<QuotaSettings> {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) throw new AuthError("empty body", 400);
  const patch: Partial<QuotaSettings> = {};
  for (const k of keys) {
    const v = b[k];
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new AuthError("enabled must be a boolean", 400);
      patch.enabled = v;
    } else if (k === "dailyTokens" || k === "monthlyTokens") {
      if (!isLimit(v)) throw new AuthError(`${k} must be an integer from 0 to ${QUOTA_MAX}`, 400);
      patch[k] = v;
    } else {
      throw new AuthError(`unknown field: ${k}`, 400);
    }
  }
  return patch;
}

/** PUT /admin/quotas: validates, writes the merged value, audits one row per changed key. */
export function updateQuotas(actor: Actor, body: unknown): QuotaSettings {
  const patch = parseQuotaPatch(body);
  const before = readQuotaSettings();
  const next = { ...before, ...patch };
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify({ ...readStored(), ...next }), Date.now());
  for (const k of Object.keys(patch) as (keyof QuotaSettings)[]) {
    if (before[k] !== next[k]) recordAudit(actor, "quotas.update", k, before[k], next[k]);
  }
  return readQuotaSettings();
}

/* ---------------- per-user overrides ---------------- */

/** The user's override row, or null (no row: the defaults apply). */
export function getUserQuota(userId: string): UserQuota | null {
  const r = db.prepare("SELECT daily_tokens, monthly_tokens FROM user_quotas WHERE user_id = ?").get(userId) as
    { daily_tokens: number | null; monthly_tokens: number | null } | undefined;
  if (!r) return null;
  return { dailyTokens: r.daily_tokens ?? null, monthlyTokens: r.monthly_tokens ?? null };
}

/** Sets the override. Both null removes the row (the defaults apply again). Audited when it changes. Throws AuthError(400). */
export function setUserQuota(actor: Actor, userId: string, q: unknown): UserQuota | null {
  const b = q && typeof q === "object" && !Array.isArray(q) ? q as Record<string, unknown> : null;
  if (!b) throw new AuthError("body must be a JSON object", 400);
  for (const k of Object.keys(b)) if (k !== "dailyTokens" && k !== "monthlyTokens") throw new AuthError(`unknown field: ${k}`, 400);
  for (const k of ["dailyTokens", "monthlyTokens"]) {
    const v = b[k];
    if (v !== null && !isLimit(v)) throw new AuthError(`${k} must be null or an integer from 0 to ${QUOTA_MAX}`, 400);
  }
  const daily = (b.dailyTokens ?? null) as number | null;
  const monthly = (b.monthlyTokens ?? null) as number | null;
  const before = getUserQuota(userId);
  if (daily === null && monthly === null) {
    db.prepare("DELETE FROM user_quotas WHERE user_id = ?").run(userId);
  } else {
    db.prepare("INSERT INTO user_quotas (user_id, daily_tokens, monthly_tokens, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET daily_tokens = excluded.daily_tokens, monthly_tokens = excluded.monthly_tokens, updated_at = excluded.updated_at")
      .run(userId, daily, monthly, Date.now());
  }
  const after = getUserQuota(userId);
  if (JSON.stringify(before) !== JSON.stringify(after)) recordAudit(actor, "quota.user", `quota:${userId}`, before, after);
  return after;
}

/** Removes the override. Returns whether a row existed. Audited when removed. */
export function deleteUserQuota(actor: Actor, userId: string): boolean {
  const before = getUserQuota(userId);
  const removed = db.prepare("DELETE FROM user_quotas WHERE user_id = ?").run(userId).changes > 0;
  if (removed) recordAudit(actor, "quota.user", `quota:${userId}`, before, null);
  return removed;
}

/** User deletion: removes the override and the usage rows (no audit). */
export function removeUserQuota(userId: string): void {
  db.prepare("DELETE FROM user_quotas WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM quota_usage WHERE user_id = ?").run(userId);
}

/* ---------------- usage ---------------- */

/** Adds tokens to the user's usage for today. Zero or negative amounts are ignored. */
export function addQuotaUsage(userId: string, tokens: number, now: number = Date.now()): void {
  const n = Math.round(tokens);
  if (!Number.isFinite(n) || n <= 0) return;
  db.prepare("INSERT INTO quota_usage (user_id, day, tokens) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET tokens = tokens + excluded.tokens")
    .run(userId, localDay(now), n);
}

export function usageToday(userId: string, now: number = Date.now()): number {
  const r = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM quota_usage WHERE user_id = ? AND day = ?").get(userId, localDay(now)) as { t: number };
  return Number(r.t) || 0;
}

export function usageThisMonth(userId: string, now: number = Date.now()): number {
  const r = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM quota_usage WHERE user_id = ? AND day >= ? AND day <= ?")
    .get(userId, monthStartDay(now), localDay(now)) as { t: number };
  return Number(r.t) || 0;
}

/** Deletes usage rows older than QUOTA_KEEP_DAYS. Returns the number of rows removed. */
export function cleanupQuotaUsage(now: number = Date.now()): number {
  return Number(db.prepare("DELETE FROM quota_usage WHERE day < ?").run(localDay(now - QUOTA_KEEP_DAYS * DAY_MS)).changes);
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

/** Starts the daily cleanup of old usage rows (once at start, then every 24 hours). */
export function startQuotaCleanup(): void {
  if (cleanupTimer) return;
  try { cleanupQuotaUsage(); } catch (e) { console.error("quota cleanup failed", e); }
  cleanupTimer = setInterval(() => {
    try { cleanupQuotaUsage(); } catch (e) { console.error("quota cleanup failed", e); }
  }, DAY_MS);
  cleanupTimer.unref?.();
}

export function stopQuotaCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}

/* ---------------- limits and checks ---------------- */

/** Whether a provider row is exempt: the user's own, a non-shared one, or the user is an admin. */
export function quotaExempt(userId: string, providerRow: { user_id: string; shared?: number | boolean | null } | null | undefined): boolean {
  if (!providerRow) return true;
  if (providerRow.user_id === userId) return true;
  if (!providerRow.shared) return true;
  return isAdminUser(userId);
}

/** The limits this user is held to (null = unlimited). Nothing is limited while the master switch is off. */
export function effectiveLimits(userId: string): { daily: number | null; monthly: number | null } {
  const s = readQuotaSettings();
  if (!s.enabled) return { daily: null, monthly: null };
  const o = getUserQuota(userId);
  const pick = (ov: number | null | undefined, def: number): number | null => {
    const v = ov ?? def;
    return v > 0 ? v : null;
  };
  return { daily: pick(o?.dailyTokens, s.dailyTokens), monthly: pick(o?.monthlyTokens, s.monthlyTokens) };
}

export interface QuotaRefusal { code: "quota_exceeded"; message: string }

/**
 * Checked before a turn starts on a shared provider. Refuses when today's or this month's usage has already reached the limit
 * (a reply in progress is never stopped). Returns null when the turn may run.
 */
export function quotaRefusal(userId: string, providerRow: any, now: number = Date.now()): QuotaRefusal | null {
  if (quotaExempt(userId, providerRow)) return null;
  const lim = effectiveLimits(userId);
  if (lim.daily !== null) {
    const used = usageToday(userId, now);
    if (used >= lim.daily) return { code: "quota_exceeded", message: `The daily token limit for shared models is reached (${used} of ${lim.daily}). It resets at ${nextDayReset(now)}.` };
  }
  if (lim.monthly !== null) {
    const used = usageThisMonth(userId, now);
    if (used >= lim.monthly) return { code: "quota_exceeded", message: `The monthly token limit for shared models is reached (${used} of ${lim.monthly}). It resets at ${nextMonthReset(now)}.` };
  }
  return null;
}

/** Counts the tokens of one finished reply on a shared provider (not the user's own, not for admins). */
export function recordQuotaUsage(userId: string, providerRow: any, tokens: number, now: number = Date.now()): void {
  if (quotaExempt(userId, providerRow)) return;
  addQuotaUsage(userId, tokens, now);
}

/** The user's own status (GET /quota). applies = an ordinary user who may use at least one shared provider. */
export function quotaStatus(userId: string, now: number = Date.now()) {
  const s = readQuotaSettings();
  const lim = effectiveLimits(userId);
  const applies = !isAdminUser(userId) && listSharedProvidersFor(userId).length > 0;
  return {
    enabled: s.enabled,
    applies,
    daily: { used: usageToday(userId, now), limit: lim.daily, resetsAt: nextDayReset(now) },
    monthly: { used: usageThisMonth(userId, now), limit: lim.monthly, resetsAt: nextMonthReset(now) },
  };
}

/* ---------------- HTTP ---------------- */

function userIdParam(req: FastifyRequest): string {
  const id = (req.params as { userId?: unknown }).userId;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new AuthError("invalid user id", 400);
  return id;
}

export function registerQuotaRoutes(app: FastifyInstance): void {
  app.get("/quota", async (req) => quotaStatus(authFromRequest(req).userId));

  app.get("/admin/quotas", async (req) => {
    requireAdminUser(req);
    return { quotas: readQuotaSettings() };
  });

  app.put("/admin/quotas", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    return { quotas: updateQuotas(a.actor, req.body) };
  });

  /** Every user with their override (or null), today's and this month's usage, and the effective limits. */
  app.get("/admin/quotas/users", async (req) => {
    requireAdminUser(req);
    const now = Date.now();
    const users = db.prepare("SELECT id, username FROM users ORDER BY created_at, id").all() as { id: string; username: string }[];
    return {
      quotas: readQuotaSettings(),
      users: users.map((u) => ({
        userId: u.id,
        username: u.username,
        isAdmin: isAdminUser(u.id),
        override: getUserQuota(u.id),
        limits: effectiveLimits(u.id),
        usedToday: usageToday(u.id, now),
        usedThisMonth: usageThisMonth(u.id, now),
      })),
    };
  });

  app.put("/admin/quotas/users/:userId", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const uid = userIdParam(req);
    if (!db.prepare("SELECT 1 AS ok FROM users WHERE id = ?").get(uid)) throw new AuthError("User not found", 404);
    return { userId: uid, override: setUserQuota(a.actor, uid, req.body) };
  });

  app.delete("/admin/quotas/users/:userId", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const uid = userIdParam(req);
    if (!db.prepare("SELECT 1 AS ok FROM users WHERE id = ?").get(uid)) throw new AuthError("User not found", 404);
    return { ok: true, removed: deleteUserQuota(a.actor, uid) };
  });
}
