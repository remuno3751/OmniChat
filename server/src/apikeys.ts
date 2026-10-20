import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { sha256 } from "./migrate-auth.js";
import { AuthError, authFromRequest } from "./auth.js";

/** API key -> userId (null if unknown/deleted). Throttles last_used_at to once a minute. */
export function userFromApiKey(key: string | undefined | null): { userId: string; keyId: string } | null {
  if (!key || !key.startsWith("ocsk-")) return null;
  const row = db.prepare("SELECT id, user_id, last_used_at FROM api_keys WHERE key_hash = ? AND deleted = 0 AND user_id NOT IN (SELECT id FROM users WHERE disabled_at IS NOT NULL)").get(sha256(key)) as
    | { id: string; user_id: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.last_used_at === null || now - row.last_used_at >= 60_000) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { userId: row.user_id, keyId: row.id };
}

/** Mints an API key for a user. The plain key is returned once and never stored. */
export function createApiKey(userId: string, nameIn: unknown): { id: string; name: string; key: string; prefix: string; createdAt: number } {
  const name = typeof nameIn === "string" && nameIn.trim() ? nameIn.trim().slice(0, 100) : "API key";
  const key = "ocsk-" + randomBytes(24).toString("base64url");
  const id = randomUUID();
  const createdAt = Date.now();
  const prefix = key.slice(0, 10);
  db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, userId, name, prefix, sha256(key), createdAt);
  return { id, name, key, prefix, createdAt };
}

/** Soft-deletes one of the user's API keys. Returns false when no such live key exists. */
export function revokeApiKey(userId: string, id: string): boolean {
  const r = db.prepare("UPDATE api_keys SET deleted = 1 WHERE id = ? AND user_id = ? AND deleted = 0").run(id, userId);
  return Number(r.changes) > 0;
}

export function registerApiKeys(app: FastifyInstance): void {
  app.post("/apikeys", async (req) => {
    const a = authFromRequest(req);
    const b = (req.body ?? {}) as any;
    return createApiKey(a.userId, b.name);
  });
  app.get("/apikeys", async (req) => {
    const a = authFromRequest(req);
    const rows = db.prepare("SELECT * FROM api_keys WHERE user_id = ? AND deleted = 0 ORDER BY created_at").all(a.userId) as any[];
    return { keys: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null })) };
  });
  app.delete("/apikeys/:id", async (req) => {
    const a = authFromRequest(req);
    if (!revokeApiKey(a.userId, (req.params as any).id)) throw new AuthError("API key not found", 404);
    return { ok: true };
  });
}
