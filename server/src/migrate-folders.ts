import type { DatabaseSync } from "node:sqlite";

/** Idempotent: chat folders (separate from projects, see folders.ts) and the conversations.folder_id column. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_folders_user_seq ON chat_folders (user_id, seq);
`);
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "folder_id")) db.exec("ALTER TABLE conversations ADD COLUMN folder_id TEXT");
}
