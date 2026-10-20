import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v3 phase 5 schema (pinned chats). */
export function migrate(db: DatabaseSync): void {
  addColumn(db, "conversations", "pinned", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "pinned_at", "INTEGER");
}
