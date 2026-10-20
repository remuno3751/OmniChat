import type { DatabaseSync } from "node:sqlite";

/** Idempotent: plugins installed from GitHub (docs/PROTOCOL-v7-plugins.md). Rows exist only for managed plugins; hand-placed folders have no row. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS plugin_installs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  repo TEXT,
  ref TEXT,
  subdir TEXT,
  commit_sha TEXT,
  version TEXT,
  files_sha256 TEXT NOT NULL,
  scan_json TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0
);
`);
}
