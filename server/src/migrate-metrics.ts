import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v3 phase 2 schema (messages.reasoning, metrics table). */
export function migrate(db: DatabaseSync): void {
  addColumn(db, "messages", "reasoning", "TEXT");
  db.exec(`
CREATE TABLE IF NOT EXISTS metrics (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  provider_id TEXT,
  provider_kind TEXT,
  model TEXT,
  quantization TEXT,
  context_length INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms REAL,
  total_ms REAL,
  prefill_tps REAL,
  decode_tps REAL,
  source TEXT NOT NULL,
  usage_exact INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_user_created ON metrics (user_id, created_at);
CREATE INDEX IF NOT EXISTS metrics_user_conv ON metrics (user_id, conversation_id);
`);
}
