import type { DatabaseSync } from "node:sqlite";

/** Idempotent: attachments (docs/design/ATTACHMENTS.md). The bytes live on disk under DATA_DIR/attachments/<userId>/<id>. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  text_path TEXT,
  text_chars INTEGER,
  transcript TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_user ON attachments (user_id, created_at);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id);
CREATE INDEX IF NOT EXISTS attachments_conversation ON attachments (conversation_id);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS message_attachments_attachment ON message_attachments (attachment_id);
`);
}
