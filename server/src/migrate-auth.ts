import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Idempotent: devices, api_keys, users.is_admin, legacy sessions -> devices. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id);
`);
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "is_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "disabled_at")) {
    db.exec("ALTER TABLE users ADD COLUMN disabled_at INTEGER");
  }
  // Pre-v3 databases: the oldest user becomes admin.
  if (!db.prepare("SELECT 1 FROM users WHERE is_admin = 1").get()) {
    db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1)");
  }
  // Legacy session tokens -> devices named 'Legacy' (once; rows are removed afterwards).
  const legacy = db.prepare("SELECT token, user_id, created_at FROM sessions").all() as { token: string; user_id: string; created_at: number }[];
  if (legacy.length) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO devices (id, user_id, name, platform, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    try {
      for (const s of legacy) {
        ins.run(crypto.randomUUID(), s.user_id, "Legacy", "", sha256(s.token), s.created_at, s.created_at);
      }
      db.exec("DELETE FROM sessions");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
