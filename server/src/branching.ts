import { db, nextSeq, toConversation, getConversationRow } from "./db.js";

/** Rows root -> leaf (inclusive) following parent_id inside one conversation. Cycle safe. */
export function pathRows(conversationId: string, leafId: string | null): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const get = db.prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ?");
  let cur = leafId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = get.get(cur, conversationId) as any;
    if (!r) break;
    out.push(r);
    cur = r.parent_id ?? null;
  }
  return out.reverse();
}

/** Messages sharing a parent, ordered by createdAt. */
export function siblings(conversationId: string, parentId: string | null): any[] {
  return db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS ? ORDER BY created_at, seq")
    .all(conversationId, parentId) as any[];
}

/** The latest message of a conversation by creation order (fallback head for legacy rows). */
export function lastMessageId(conversationId: string): string | null {
  const r = db
    .prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1")
    .get(conversationId) as any;
  return r?.id ?? null;
}

export function messageBelongs(conversationId: string, messageId: string): boolean {
  return !!db.prepare("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?").get(messageId, conversationId);
}

/** Move head (no validation); bumps seq. Returns the serialised conversation. */
export function setHead(conversationId: string, headId: string | null) {
  db.prepare("UPDATE conversations SET head_id = ?, seq = ? WHERE id = ?").run(headId, nextSeq(), conversationId);
  return toConversation(getConversationRow(conversationId));
}
