import type { DatabaseSync } from "node:sqlite";

/** Idempotent: usage quotas for shared providers (docs/PROTOCOL-v7-quotas.md). Defaults live in server_settings ("quotas"). */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY,
  daily_tokens INTEGER,
  monthly_tokens INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);
}
