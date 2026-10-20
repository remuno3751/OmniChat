import type { DatabaseSync } from "node:sqlite";

/** Idempotent: server-wide settings (PROTOCOL-v6.md 1.1b). key/value, the value is JSON. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
}
