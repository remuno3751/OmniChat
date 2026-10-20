/* Shared core of the admin API (PROTOCOL-v7-admin.md): admin guard, rate limits, audit trail, general settings. */
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { maskSecrets } from "./logring.js";
import { readGeneral, writeGeneralRaw, type GeneralPatch, type GeneralSettings } from "./server-general.js";

export interface Actor { id: string; name: string }

export interface AuditEntry {
  id: number;
  at: number;
  actorId: string;
  actor: string;
  action: string;
  key: string;
  oldValue: string | null;
  newValue: string | null;
}

const AUDIT_CLIP = 200;
const SECRET_KEY = /token|key|password|secret|hash/i;

/** Name of a user for audit rows (fallback "unknown"). */
export function actorOf(userId: string): Actor {
  const row = db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
  return { id: userId, name: row?.username ?? "unknown" };
}

/** Audit representation of a value: secrets as "***" (or "unset"), everything else masked and clipped to 200 chars. */
export function maskAuditValue(key: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (SECRET_KEY.test(key)) return v === "" ? "unset" : "***";
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "object") {
    try { s = JSON.stringify(v) ?? String(v); } catch { s = "[object]"; }
  } else s = String(v);
  return maskSecrets(s).slice(0, AUDIT_CLIP);
}

/** Inserts one audit row. Never throws: an audit failure must not break the change it describes. */
export function recordAudit(actor: Actor, action: string, key: string, oldV?: unknown, newV?: unknown): void {
  try {
    db.prepare("INSERT INTO admin_audit (at, actor_id, actor_name, action, key, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), actor.id, actor.name, action, key, maskAuditValue(key, oldV), maskAuditValue(key, newV));
  } catch { /* best effort */ }
}

/** Newest first; limit clamped to 1..200. */
export function listAudit(limit: number): AuditEntry[] {
  const n = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 50;
  const rows = db.prepare("SELECT id, at, actor_id, actor_name, action, key, old_value, new_value FROM admin_audit ORDER BY id DESC LIMIT ?").all(n) as {
    id: number; at: number; actor_id: string; actor_name: string; action: string; key: string; old_value: string | null; new_value: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id, at: r.at, actorId: r.actor_id, actor: r.actor_name, action: r.action, key: r.key,
    oldValue: r.old_value ?? null, newValue: r.new_value ?? null,
  }));
}

const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS: Record<"mutation" | "sensitive", number> = { mutation: 30, sensitive: 10 };
const rateHits = new Map<string, number[]>();

/** Sliding one-minute window per (user, bucket). Exceeding it throws a 429 AuthError. */
export function checkRate(userId: string, bucket: "mutation" | "sensitive"): void {
  const now = Date.now();
  const key = `${userId}:${bucket}`;
  const recent = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMITS[bucket]) {
    rateHits.set(key, recent);
    throw new AuthError("Too many admin changes, slow down", 429);
  }
  recent.push(now);
  rateHits.set(key, recent);
}

/** 401 for a missing/bad token (from authFromRequest); 403 "Admin only" unless the user is an enabled admin. */
export function requireAdminUser(req: { headers: Record<string, any> }): { userId: string; deviceId: string; actor: Actor } {
  const who = authFromRequest(req);
  const row = db.prepare("SELECT 1 AS ok FROM users WHERE id = ? AND is_admin = 1 AND disabled_at IS NULL").get(who.userId);
  if (!row) throw new AuthError("Admin only", 403);
  return { userId: who.userId, deviceId: who.deviceId, actor: { id: who.userId, name: who.username } };
}

export function getGeneral(): GeneralSettings {
  return readGeneral();
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

/** PUT /admin/settings. Validates strictly (400 on any problem), writes, and audits one row per changed key. */
export function updateGeneral(actor: Actor, body: unknown): GeneralSettings {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) throw new AuthError("empty body", 400);

  const patch: GeneralPatch = {};
  for (const k of keys) {
    const v = b[k];
    if (k === "serverName") {
      if (typeof v !== "string") throw new AuthError("serverName must be a string", 400);
      const t = v.trim();
      if (t.length > 60 || CONTROL_CHARS.test(t)) throw new AuthError("serverName must be 0..60 characters without control characters", 400);
      patch.serverName = t;
    } else if (k === "serverDescription") {
      if (typeof v !== "string" || v.length > 280 || CONTROL_CHARS.test(v)) throw new AuthError("serverDescription must be 0..280 characters without control characters", 400);
      patch.serverDescription = v;
    } else if (k === "allowRegistration") {
      if (typeof v !== "boolean") throw new AuthError("allowRegistration must be a boolean", 400);
      patch.allowRegistration = v;
    } else if (k === "defaultSharedAccess") {
      if (v !== "none" && v !== "all") throw new AuthError("defaultSharedAccess must be \"none\" or \"all\"", 400);
      patch.defaultSharedAccess = v;
    } else if (k === "allowOwnProviders") {
      if (typeof v !== "boolean") throw new AuthError("allowOwnProviders must be a boolean", 400);
      patch.allowOwnProviders = v;
    } else {
      throw new AuthError(`unknown field: ${k}`, 400);
    }
  }

  const before = readGeneral();
  const changed = (Object.keys(patch) as (keyof GeneralPatch)[]).filter((k) => before[k] !== patch[k]);
  writeGeneralRaw(patch);
  for (const k of changed) recordAudit(actor, "settings.update", k, before[k], patch[k]);
  return readGeneral();
}
