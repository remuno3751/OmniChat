import type { DatabaseSync } from "node:sqlite";

/** Idempotent: audit trail of administrative changes (PROTOCOL-v7-admin.md "Audit"). */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at);
`);
}
