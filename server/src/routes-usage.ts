import type { FastifyInstance } from "fastify";
import { getConversationRow, db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { clampTz, parseMs, usageSummary, usageDaily, usageChats, usageModels, MAX_DAYS } from "./usage.js";

/**
 * Token-usage analytics. All routes are auth-required.
 *   scope absent / "mine" -> the caller's own rows; scope "all" -> every user's rows (admins only, else 403).
 *   from / to: epoch ms, from inclusive, to exclusive; missing or non-numeric values are ignored.
 *   tz: integer minutes east of UTC (clamped to [-840, 840], default 0).
 * Response shapes: see the functions in usage.ts.
 */

const caller = (req: { headers: Record<string, any> }): string => authFromRequest(req).userId;

/** Returns the user filter: the caller's id, or null for scope=all (admin only). */
function scopeUserId(req: { headers: Record<string, any> }, scope: unknown): string | null {
  const userId = caller(req);
  if (scope === undefined || scope === "" || scope === "mine") return userId;
  if (scope !== "all") throw new AuthError("scope must be mine or all", 400);
  const u = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
  if (!u?.is_admin) throw new AuthError("Admin only", 403);
  return null;
}

/** conversationId filter: must be one of the caller's conversations (ephemeral ids are never counted). */
function ownConversation(userId: string, id: unknown): string | null {
  if (id === undefined || id === "") return null;
  if (typeof id !== "string" || id.startsWith("eph_")) throw new AuthError("Conversation not found", 404);
  const conv = getConversationRow(id) as { user_id: string } | undefined;
  if (!conv || conv.user_id !== userId) throw new AuthError("Conversation not found", 404);
  return id;
}

function parseInteger(raw: unknown, def: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new AuthError(`${name} must be an integer ${min}..${max}`, 400);
  return n;
}

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/usage/summary", async (req) => {
    const q = req.query as Record<string, unknown>;
    const userId = scopeUserId(req, q.scope);
    const conversationId = ownConversation(caller(req), q.conversationId);
    return usageSummary({ userId, from: parseMs(q.from), to: parseMs(q.to), conversationId }, clampTz(q.tz));
  });

  app.get("/usage/daily", async (req) => {
    const q = req.query as Record<string, unknown>;
    const userId = scopeUserId(req, q.scope);
    const days = parseInteger(q.days, 30, 0, MAX_DAYS, "days");
    return usageDaily({ userId, days, tz: clampTz(q.tz) });
  });

  app.get("/usage/chats", async (req) => {
    const q = req.query as Record<string, unknown>;
    const userId = scopeUserId(req, q.scope);
    const limit = parseInteger(q.limit, 20, 1, 200, "limit");
    return usageChats({ userId, from: parseMs(q.from), to: parseMs(q.to) }, limit);
  });

  app.get("/usage/models", async (req) => {
    const q = req.query as Record<string, unknown>;
    const userId = scopeUserId(req, q.scope);
    return usageModels({ userId, from: parseMs(q.from), to: parseMs(q.to) });
  });
}
