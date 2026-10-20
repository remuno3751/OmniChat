import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v3 chat schema (projects, presets, settings, branching columns) + linear chaining of legacy messages. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT,
  system_mode TEXT NOT NULL DEFAULT 'append',
  default_provider_id TEXT,
  default_model TEXT,
  effort TEXT,
  params TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user_seq ON projects (user_id, seq);
CREATE TABLE IF NOT EXISTS prompt_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS presets_user_seq ON prompt_presets (user_id, seq);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}',
  seq INTEGER NOT NULL
);
`);
  addColumn(db, "conversations", "project_id", "TEXT");
  addColumn(db, "conversations", "system_prompt", "TEXT");
  addColumn(db, "conversations", "system_mode", "TEXT NOT NULL DEFAULT 'append'");
  addColumn(db, "conversations", "effort", "TEXT");
  addColumn(db, "conversations", "params", "TEXT");
  // the title the server last wrote automatically; only a title still equal to it is refreshed
  addColumn(db, "conversations", "auto_title", "TEXT");
  addColumn(db, "conversations", "head_id", "TEXT");
  // /compact: a persisted summary of the path up to compact_upto (the last covered message); originals are kept.
  addColumn(db, "conversations", "compact_summary", "TEXT");
  addColumn(db, "conversations", "compact_upto", "TEXT");
  addColumn(db, "conversations", "compact_at", "INTEGER");
  addColumn(db, "messages", "parent_id", "TEXT");
  addColumn(db, "messages", "debug", "TEXT");
  // how effort is sent to a provider (effort.ts profiles); null = the per-kind map
  addColumn(db, "providers", "effort_profile", "TEXT");
  // shared providers (SHARED-PROVIDERS.md): an admin-owned provider that other users may use under their grants
  addColumn(db, "providers", "shared", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
CREATE TABLE IF NOT EXISTS user_model_grants (
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('all','list','none')),
  models TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);
CREATE INDEX IF NOT EXISTS user_model_grants_provider ON user_model_grants (provider_id);
`);
  db.exec("CREATE INDEX IF NOT EXISTS messages_parent ON messages (conversation_id, parent_id)");
  db.exec("CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project_id)");

  // Legacy data: chain messages linearly by created_at (only conversations with no parent_id / head_id yet).
  const convs = db
    .prepare(
      "SELECT c.id FROM conversations c WHERE c.head_id IS NULL AND " +
      "EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) AND " +
      "NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.parent_id IS NOT NULL)",
    )
    .all() as { id: string }[];
  if (!convs.length) return;
  const seq = () => (db.prepare("UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value").get() as { value: number }).value;
  const msgs = db.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at, seq");
  const setParent = db.prepare("UPDATE messages SET parent_id = ?, seq = ? WHERE id = ?");
  const setHead = db.prepare("UPDATE conversations SET head_id = ?, seq = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const c of convs) {
      const rows = msgs.all(c.id) as { id: string }[];
      let prev: string | null = null;
      for (const r of rows) {
        setParent.run(prev, seq(), r.id);
        prev = r.id;
      }
      setHead.run(prev, seq(), c.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
