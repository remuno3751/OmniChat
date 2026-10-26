import type { DatabaseSync } from "node:sqlite";

/** Idempotent: Aria voice call (docs/design/ARIA-HOST.md). Per-user prefs, voice-model owners and kinds, daily usage, messages.via. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS voice_user_prefs (
  user_id TEXT PRIMARY KEY,
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_models (
  uuid TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'aivmx',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_models_owner ON voice_models (owner_user_id);
CREATE TABLE IF NOT EXISTS voice_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  call_seconds INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  reply_chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);
  // Databases made before `kind` existed: add the column (existing models are standard .aivmx voices).
  const vm = db.prepare("PRAGMA table_info(voice_models)").all() as { name: string }[];
  if (!vm.some((c) => c.name === "kind")) db.exec("ALTER TABLE voice_models ADD COLUMN kind TEXT NOT NULL DEFAULT 'aivmx'");
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "via")) db.exec("ALTER TABLE messages ADD COLUMN via TEXT");
}
