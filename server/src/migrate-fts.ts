import type { DatabaseSync } from "node:sqlite";

/**
 * Idempotent: full-text index over message content and conversation titles.
 * FTS5 `trigram` tokenizer (substring search incl. CJK / emoji). Standalone FTS table keyed by an
 * AUTOINCREMENT id in `fts_map` (messages/conversations have TEXT primary keys, whose rowids may change on VACUUM).
 * Streaming messages are not indexed until they leave the 'streaming' status, so triggers stay cheap.
 * Falls back to unicode61 when the SQLite build lacks the trigram tokenizer (search then uses LIKE for CJK/short terms).
 */
export function migrate(db: DatabaseSync): void {
  let tokenizer = "trigram";
  const create = (tok: string) =>
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_history USING fts5(text, tokenize='${tok}')`);
  try { create("trigram"); } catch { tokenizer = "unicode61"; create("unicode61"); }
  db.exec(`
CREATE TABLE IF NOT EXISTS fts_map (
  fid INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  UNIQUE (kind, id)
);
CREATE TABLE IF NOT EXISTS fts_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

DROP TRIGGER IF EXISTS fts_m_ai;
DROP TRIGGER IF EXISTS fts_m_au;
DROP TRIGGER IF EXISTS fts_m_ad;
DROP TRIGGER IF EXISTS fts_c_ai;
DROP TRIGGER IF EXISTS fts_c_au;
DROP TRIGGER IF EXISTS fts_c_ad;

CREATE TRIGGER fts_m_ai AFTER INSERT ON messages WHEN new.status <> 'streaming' AND new.content <> '' BEGIN
  INSERT OR IGNORE INTO fts_map (kind, id) VALUES ('m', new.id);
  INSERT INTO fts_history (rowid, text) SELECT fid, new.content FROM fts_map WHERE kind = 'm' AND id = new.id;
END;
CREATE TRIGGER fts_m_au AFTER UPDATE OF content, status ON messages WHEN new.status <> 'streaming' BEGIN
  DELETE FROM fts_history WHERE rowid = (SELECT fid FROM fts_map WHERE kind = 'm' AND id = new.id);
  INSERT OR IGNORE INTO fts_map (kind, id) SELECT 'm', new.id WHERE new.content <> '';
  INSERT INTO fts_history (rowid, text) SELECT fid, new.content FROM fts_map WHERE kind = 'm' AND id = new.id AND new.content <> '';
END;
CREATE TRIGGER fts_m_ad AFTER DELETE ON messages BEGIN
  DELETE FROM fts_history WHERE rowid = (SELECT fid FROM fts_map WHERE kind = 'm' AND id = old.id);
  DELETE FROM fts_map WHERE kind = 'm' AND id = old.id;
END;

CREATE TRIGGER fts_c_ai AFTER INSERT ON conversations WHEN new.title <> '' BEGIN
  INSERT OR IGNORE INTO fts_map (kind, id) VALUES ('c', new.id);
  INSERT INTO fts_history (rowid, text) SELECT fid, new.title FROM fts_map WHERE kind = 'c' AND id = new.id;
END;
CREATE TRIGGER fts_c_au AFTER UPDATE OF title ON conversations WHEN old.title IS NOT new.title BEGIN
  DELETE FROM fts_history WHERE rowid = (SELECT fid FROM fts_map WHERE kind = 'c' AND id = new.id);
  INSERT OR IGNORE INTO fts_map (kind, id) SELECT 'c', new.id WHERE new.title <> '';
  INSERT INTO fts_history (rowid, text) SELECT fid, new.title FROM fts_map WHERE kind = 'c' AND id = new.id AND new.title <> '';
END;
CREATE TRIGGER fts_c_ad AFTER DELETE ON conversations BEGIN
  DELETE FROM fts_history WHERE rowid = (SELECT fid FROM fts_map WHERE kind = 'c' AND id = old.id);
  DELETE FROM fts_map WHERE kind = 'c' AND id = old.id;
END;
`);
  db.prepare("INSERT OR REPLACE INTO fts_meta (k, v) VALUES ('tokenizer', ?)").run(tokenizer);

  // Backfill rows that are not indexed yet (first run / rows written while the triggers did not exist).
  db.exec("BEGIN");
  try {
    db.exec(`
INSERT OR IGNORE INTO fts_map (kind, id)
  SELECT 'm', id FROM messages WHERE status <> 'streaming' AND content <> '' AND id NOT IN (SELECT id FROM fts_map WHERE kind = 'm');
INSERT INTO fts_history (rowid, text)
  SELECT f.fid, m.content FROM fts_map f JOIN messages m ON f.kind = 'm' AND m.id = f.id
  WHERE f.fid NOT IN (SELECT rowid FROM fts_history) AND m.status <> 'streaming' AND m.content <> '';
INSERT OR IGNORE INTO fts_map (kind, id)
  SELECT 'c', id FROM conversations WHERE title <> '' AND id NOT IN (SELECT id FROM fts_map WHERE kind = 'c');
INSERT INTO fts_history (rowid, text)
  SELECT f.fid, c.title FROM fts_map f JOIN conversations c ON f.kind = 'c' AND c.id = f.id
  WHERE f.fid NOT IN (SELECT rowid FROM fts_history) AND c.title <> '';
`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
