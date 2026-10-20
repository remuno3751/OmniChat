import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v3 phase 4 schema (response format, json validity, comparisons, benchmark sets / runs / results). */
export function migrate(db: DatabaseSync): void {
  addColumn(db, "conversations", "response_format", "TEXT");
  addColumn(db, "metrics", "json_valid", "INTEGER");
  addColumn(db, "metrics", "json_error", "TEXT");
  db.exec(`
CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  targets TEXT NOT NULL,
  results TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comparisons_user_created ON comparisons (user_id, created_at);
CREATE TABLE IF NOT EXISTS bench_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompts TEXT NOT NULL,
  system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bench_sets_user ON bench_sets (user_id);
CREATE TABLE IF NOT EXISTS bench_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  set_id TEXT,
  set_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  targets TEXT NOT NULL,
  repeats INTEGER NOT NULL,
  warmup INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  prompt_count INTEGER NOT NULL,
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS bench_runs_user_started ON bench_runs (user_id, started_at);
CREATE TABLE IF NOT EXISTS bench_results (
  run_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, n)
);
`);
  // A server restart kills running benchmarks.
  db.prepare("UPDATE bench_runs SET status = 'error', error = 'server restarted during the run', finished_at = ? WHERE status = 'running'").run(Date.now());
}
