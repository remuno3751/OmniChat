import type { DatabaseSync } from "node:sqlite";

function addColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/** Idempotent: v3 phase 3 schema (tool grants, tool-call trace / sources on messages, tools + search mode on conversations / projects). */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS tool_grants (
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tool_name)
);
`);
  addColumn(db, "messages", "tool_calls", "TEXT");
  addColumn(db, "messages", "sources", "TEXT");
  addColumn(db, "conversations", "tools", "TEXT");
  addColumn(db, "conversations", "search_mode", "TEXT");
  addColumn(db, "conversations", "context_overflow", "TEXT");
  addColumn(db, "projects", "tools", "TEXT");
  addColumn(db, "projects", "search_mode", "TEXT");
  // one-time default: web search pre-approved for existing accounts (a later revoke sticks because of the marker row)
  if (process.env.OMNICHAT_DEFAULT_SEARCH_GRANT !== "0") {
    const t = Date.now();
    db.exec(`INSERT OR IGNORE INTO tool_grants (user_id, tool_name, granted_at) SELECT id, 'web_search', ${t} FROM users WHERE id NOT IN (SELECT user_id FROM tool_grants WHERE tool_name = '__defaults_v1__')`);
    db.exec(`INSERT OR IGNORE INTO tool_grants (user_id, tool_name, granted_at) SELECT id, '__defaults_v1__', ${t} FROM users`);
  }
}
