// Admin-only account management for the remote admin API (PROTOCOL v7). Every mutation writes audit rows.
import { db } from "./db.js";
import { deleteAttachmentsOfUser } from "./attachments-retention.js";
import { removeProviderGrants, removeUserGrants } from "./shared-providers.js";
import { removeUserQuota } from "./quota.js";
import { AuthError, createUserDirect, setPassword } from "./auth.js";
import { activeAdmins, setDisabled, setRole } from "./users-admin.js";
import { recordAudit, type Actor } from "./admin-core.js";

export interface AdminUserRow {
  id: string;
  username: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  devices: number;
  tokens30d: number;
}

const DAY_MS = 30 * 24 * 60 * 60 * 1000;

interface UserRow { id: string; username: string; is_admin: number; disabled_at: number | null; created_at: number }

function obj(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AuthError("Request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

function onlyKeys(b: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new AuthError(`Unknown field: ${k}`, 400);
}

function userRow(id: string): UserRow {
  const u = db.prepare("SELECT id, username, is_admin, disabled_at, created_at FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!u) throw new AuthError("User not found", 404);
  return u;
}

function parseRole(v: unknown): "admin" | "user" {
  if (v !== "admin" && v !== "user") throw new AuthError("role must be 'admin' or 'user'", 400);
  return v;
}

function activeDeviceCount(userId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS c FROM devices WHERE user_id = ? AND revoked_at IS NULL").get(userId) as any).c);
}

export function adminListUsers(callerId: string): { users: AdminUserRow[]; you: string } {
  const since = Date.now() - DAY_MS;
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, u.disabled_at, u.created_at,
              (SELECT MAX(d.last_seen_at) FROM devices d WHERE d.user_id = u.id) AS last_seen,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
              (SELECT COALESCE(SUM(m.prompt_tokens + m.completion_tokens), 0) FROM metrics m WHERE m.user_id = u.id AND m.created_at >= ?) AS tokens30d
       FROM users u ORDER BY u.created_at, u.rowid`,
    )
    .all(since) as any[];
  const users: AdminUserRow[] = rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.is_admin ? "admin" : "user",
    disabled: r.disabled_at != null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen == null ? null : Number(r.last_seen),
    devices: Number(r.devices),
    tokens30d: Number(r.tokens30d),
  }));
  return { users, you: callerId };
}

export async function adminCreateUser(actor: Actor, body: unknown): Promise<{ id: string; username: string; role: "admin" | "user" }> {
  const b = obj(body);
  onlyKeys(b, ["username", "password", "role"]);
  const role = b.role === undefined ? "user" : parseRole(b.role);
  const r = await createUserDirect(b.username, b.password, role === "admin");
  recordAudit(actor, "user.create", r.username, undefined, role);
  return { id: r.userId, username: r.username, role };
}

export function adminPatchUser(actor: Actor, id: string, body: unknown): void {
  const b = obj(body);
  onlyKeys(b, ["role", "disabled"]);
  if (b.role === undefined && b.disabled === undefined) throw new AuthError("Nothing to change: give role and/or disabled", 400);
  if (b.role !== undefined) parseRole(b.role);
  if (b.disabled !== undefined && typeof b.disabled !== "boolean") throw new AuthError("disabled must be a boolean", 400);
  const u = userRow(id);
  if (b.disabled === true && id === actor.id) throw new AuthError("You cannot disable your own account", 409);

  // setRole/setDisabled carry the last-admin guard (409) and throw before writing, so a failed second step cannot leave a partial change.
  if (b.role !== undefined) {
    const oldRole = u.is_admin ? "admin" : "user";
    if (b.role !== oldRole) {
      setRole(id, b.role);
      recordAudit(actor, "user.role", u.username, oldRole, b.role);
    }
  }
  if (b.disabled !== undefined) {
    const wasDisabled = u.disabled_at != null;
    if (b.disabled !== wasDisabled) {
      setDisabled(id, b.disabled);
      recordAudit(actor, b.disabled ? "user.disable" : "user.enable", u.username, wasDisabled ? "disabled" : "enabled", b.disabled ? "disabled" : "enabled");
    }
  }
}

export async function adminResetPassword(actor: Actor, keepDeviceId: string, id: string, body: unknown): Promise<{ revokedDevices: number }> {
  const b = obj(body);
  onlyKeys(b, ["password"]);
  const u = userRow(id);
  if (typeof b.password !== "string" || b.password.length < 8) throw new AuthError("Password must be at least 8 characters", 400);
  const self = id === actor.id;
  const before = activeDeviceCount(id);
  const keepActive = self
    ? !!db.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(keepDeviceId, id)
    : false;
  // setPassword revokes every device of the user; the caller's own device is restored below.
  await setPassword(id, b.password);
  if (keepActive) db.prepare("UPDATE devices SET revoked_at = NULL WHERE id = ? AND user_id = ?").run(keepDeviceId, id);
  recordAudit(actor, "user.password", u.username, undefined, "changed");
  return { revokedDevices: before - (keepActive ? 1 : 0) };
}

export function adminRevoke(actor: Actor, keepDeviceId: string, id: string): { revokedDevices: number; revokedKeys: number } {
  const u = userRow(id);
  const exclude = id === actor.id ? keepDeviceId : null;
  const devices = Number(
    db.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?").run(Date.now(), id, exclude).changes,
  );
  const keys = Number(db.prepare("UPDATE api_keys SET deleted = 1 WHERE user_id = ? AND deleted = 0").run(id).changes);
  recordAudit(actor, "user.revoke", u.username, undefined, `devices:${devices} keys:${keys}`);
  return { revokedDevices: devices, revokedKeys: keys };
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Every table of the main database with the given column; names come from sqlite_master, never from input. */
function tablesWithColumn(column: string): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const out: string[] = [];
  for (const { name } of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as { name: string }[];
      if (cols.some((c) => c.name === column)) out.push(name);
    } catch {
      /* cannot inspect this table: skip it */
    }
  }
  return out;
}

/** Removes every row of the user (inside the caller's transaction). Order: message-keyed, conversation-keyed, user-keyed, user. */
function purgeUser(userId: string): void {
  // grants on the user's own providers, and the user's grants (the rows below would otherwise leave them behind)
  for (const p of db.prepare("SELECT id FROM providers WHERE user_id = ?").all(userId) as { id: string }[]) removeProviderGrants(p.id);
  removeUserGrants(userId);
  removeUserQuota(userId);
  const convIds = "SELECT c.id FROM conversations c WHERE c.user_id = ?";
  const msgIds = "SELECT m.id FROM messages m WHERE m.user_id = ? OR m.conversation_id IN (" + convIds + ")";
  for (const t of tablesWithColumn("message_id")) {
    if (t === "messages") continue;
    db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE message_id IN (${msgIds})`).run(userId, userId);
  }
  for (const t of tablesWithColumn("conversation_id")) {
    if (t === "conversations") continue;
    db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE conversation_id IN (${convIds})`).run(userId);
  }
  for (const t of tablesWithColumn("user_id")) {
    db.prepare(`DELETE FROM ${quoteIdent(t)} WHERE user_id = ?`).run(userId);
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function adminDeleteUser(actor: Actor, id: string, body: unknown): { mode: "disabled" | "deleted" } {
  const u = userRow(id);
  const b = obj(body);
  onlyKeys(b, ["confirm", "hard"]);
  if (typeof b.confirm !== "string" || b.confirm !== u.username) throw new AuthError("Confirmation does not match", 400);
  if (b.hard !== undefined && typeof b.hard !== "boolean") throw new AuthError("hard must be a boolean", 400);
  if (id === actor.id) throw new AuthError("You cannot delete your own account", 409);
  if (u.is_admin && u.disabled_at == null && activeAdmins(id) === 0) throw new AuthError("The last administrator cannot be deleted", 409);

  if (b.hard !== true) {
    setDisabled(id, true); // also revokes all devices
    db.prepare("UPDATE api_keys SET deleted = 1 WHERE user_id = ? AND deleted = 0").run(id);
    recordAudit(actor, "user.delete", u.username, undefined, "disabled");
    return { mode: "disabled" };
  }

  // files first: purgeUser removes the attachments rows too
  try { deleteAttachmentsOfUser(id); } catch (e) { console.error("attachment cleanup failed", e); }
  db.exec("BEGIN");
  try {
    purgeUser(id);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw e;
  }
  recordAudit(actor, "user.delete", u.username, undefined, "deleted");
  return { mode: "deleted" };
}
