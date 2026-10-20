/* Server maintenance mode (docs/PROTOCOL-v7-maintenance.md). While enabled, regular users cannot use the LLM;
   admins (users.is_admin) always can. Stored in server_settings (key "maintenance") as JSON.
   Imports only db.js (not auth.js, to avoid a cycle). */
import { db } from "./db.js";

export interface Maintenance {
  enabled: boolean;
  /** Message shown to blocked users (0..500 characters, may be empty). */
  message: string;
  /** Expected end of maintenance, epoch ms, or null. */
  eta: number | null;
  /** epoch ms of the last change (0 = never changed). */
  updatedAt: number;
}

export interface MaintenancePatch {
  enabled?: boolean;
  message?: string;
  eta?: number | null;
}

export const MAINTENANCE_MAX_MESSAGE = 500;
export const MAINTENANCE_DEFAULT_MESSAGE = "The server is under maintenance. AI features are unavailable right now.";

const KEY = "maintenance";

/** The stored maintenance state (defaults: disabled). Tolerates a missing or broken row. */
export function readMaintenance(): Maintenance {
  let j: any = {};
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    j = row ? JSON.parse(row.value) : {};
  } catch { j = {}; }
  if (!j || typeof j !== "object") j = {};
  return {
    enabled: j.enabled === true,
    message: typeof j.message === "string" ? j.message : "",
    eta: Number.isSafeInteger(j.eta) && j.eta > 0 ? j.eta : null,
    updatedAt: Number.isFinite(j.updatedAt) ? j.updatedAt : 0,
  };
}

/** Merges the given fields. Validation is the caller's job (routes-admin.ts). Returns the state after the write.
 *  updatedAt changes only when enabled, message or eta actually change; nothing is written otherwise. */
export function writeMaintenance(patch: MaintenancePatch): Maintenance {
  const cur = readMaintenance();
  const next: Maintenance = {
    enabled: patch.enabled ?? cur.enabled,
    message: patch.message ?? cur.message,
    eta: patch.eta !== undefined ? patch.eta : cur.eta,
    updatedAt: cur.updatedAt,
  };
  const changed = next.enabled !== cur.enabled || next.message !== cur.message || next.eta !== cur.eta;
  if (!changed) return cur;
  next.updatedAt = Date.now();
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(next), next.updatedAt);
  return next;
}

/** Same admin test as requireAdminUser (admin-core.ts): enabled user with is_admin = 1. */
export function isAdminUser(userId: string): boolean {
  return !!db.prepare("SELECT 1 AS ok FROM users WHERE id = ? AND is_admin = 1 AND disabled_at IS NULL").get(userId);
}

/** The maintenance state if it blocks this user's LLM use (enabled and not an admin), else null. */
export function maintenanceBlocking(userId: string): Maintenance | null {
  const m = readMaintenance();
  if (!m.enabled) return null;
  return isAdminUser(userId) ? null : m;
}

/** The text shown to a blocked user: the admin's message, or the English default when empty. */
export function maintenanceText(m: Maintenance): string {
  return m.message.trim() || MAINTENANCE_DEFAULT_MESSAGE;
}

/** Retry-After in whole seconds (at least 1), or null without an eta. */
export function maintenanceRetryAfter(m: Maintenance, now = Date.now()): number | null {
  if (m.eta === null) return null;
  return Math.max(1, Math.ceil((m.eta - now) / 1000));
}

/** Thrown by HTTP LLM entry points for a blocked user; index.ts renders it as 503 + Retry-After. */
export class MaintenanceError extends Error {
  readonly status = 503;
  readonly code = "maintenance";
  readonly maintenance: Maintenance;
  constructor(m: Maintenance) {
    super(maintenanceText(m));
    this.maintenance = m;
  }
}

/** Throws MaintenanceError when this user may not use the LLM right now. */
export function assertMaintenanceAllows(userId: string): void {
  const m = maintenanceBlocking(userId);
  if (m) throw new MaintenanceError(m);
}
