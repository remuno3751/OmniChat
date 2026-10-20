// Account management used by the local admin API (server app) and the admin CLI.
import { db } from "./db.js";
import { AuthError } from "./auth.js";

export interface UserInfo { id: string; username: string; role: "admin" | "user"; disabled: boolean; createdAt: number; devices: number }

export function listUsers(): UserInfo[] {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.is_admin, u.disabled_at, u.created_at,
            (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
     FROM users u ORDER BY u.created_at, u.rowid`,
  ).all() as any[];
  return rows.map((r) => ({ id: r.id, username: r.username, role: r.is_admin ? "admin" : "user", disabled: r.disabled_at != null, createdAt: r.created_at, devices: Number(r.devices) }));
}

export const activeAdmins = (exceptId: string): number =>
  Number((db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND id != ?").get(exceptId) as any).c);

function mustExist(id: string): { id: string; is_admin: number; disabled_at: number | null } {
  const u = db.prepare("SELECT id, is_admin, disabled_at FROM users WHERE id = ?").get(id) as any;
  if (!u) throw new AuthError("User not found", 404);
  return u;
}

/** Never leaves the server without an enabled administrator. */
export function setRole(id: string, role: unknown): void {
  if (role !== "admin" && role !== "user") throw new AuthError("role must be 'admin' or 'user'");
  const u = mustExist(id);
  if (role === "user" && u.is_admin && activeAdmins(id) === 0) throw new AuthError("The last administrator cannot be demoted", 409);
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(role === "admin" ? 1 : 0, id);
}

/** Disabling signs the user out everywhere (devices revoked) and blocks login and API keys. */
export function setDisabled(id: string, disabled: unknown): void {
  if (typeof disabled !== "boolean") throw new AuthError("disabled must be a boolean");
  const u = mustExist(id);
  if (disabled && u.is_admin && activeAdmins(id) === 0) throw new AuthError("The last administrator cannot be disabled", 409);
  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(disabled ? Date.now() : null, id);
  if (disabled) db.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), id);
}

export function userExists(id: string): void { mustExist(id); }
