import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v4 schema (PROTOCOL-v4.md): mode/code status, message phases/changes/agents, approval rules, checkpoints, templates, pets. */
export function migrate(db: DatabaseSync): void {
  addColumn(db, "conversations", "mode", "TEXT NOT NULL DEFAULT 'chat'");
  addColumn(db, "conversations", "code_status", "TEXT NOT NULL DEFAULT 'idle'");
  // Code workspaces (docs/design/CODE-WORKSPACES.md): working folder of a Code conversation, NULL = unknown
  addColumn(db, "conversations", "cwd", "TEXT");
  addColumn(db, "projects", "mode", "TEXT NOT NULL DEFAULT 'chat'");
  addColumn(db, "messages", "phases", "TEXT");
  addColumn(db, "messages", "changes", "TEXT");
  addColumn(db, "messages", "agents", "TEXT");
  db.exec(`
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS approval_rules_user ON approval_rules (user_id, project_id);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  bridge TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  ref TEXT,
  unavailable TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_conv ON checkpoints (user_id, conversation_id, created_at);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'prompt',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS templates_user_seq ON templates (user_id, seq);
CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manifest TEXT NOT NULL,
  sheet BLOB NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pets_user ON pets (user_id);
`);
}
