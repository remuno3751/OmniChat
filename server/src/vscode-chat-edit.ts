/* "Edit the last prompt" from inside VS Code (docs/design/V056E-CONTRACT.md §1): a prompt with replaceLast removes the last user
   message of the conversation and everything after it, then the new text runs as a normal `send` (vscode-chat.ts onPrompt).
   Removal is the app's own: the rows are deleted from `messages` (plus their metrics and attachment links), the conversation head
   moves to the message before, and the change is broadcast as a conversation upsert. Checkpoints stay (files are not reverted). */
import { db, getConversationRow, nextSeq, toConversation } from "./db.js";
import { lastMessageId } from "./branching.js";
import { isGenerating } from "./chat.js";
import { broadcast } from "./hub.js";

export type RemoveResult = { ok: true } | { ok: false; error: string; message: string };

/** Removes the last user message and every message after it from a conversation of `userId` (ownership is checked by the caller). */
export function removeLastTurn(userId: string, conversationId: string): RemoveResult {
  const conv = getConversationRow(conversationId);
  if (!conv || conv.user_id !== userId) return { ok: false, error: "not_found", message: "Conversation not found" };
  if (isGenerating(conversationId) || conv.code_status === "running" || conv.code_status === "awaiting_approval") {
    return { ok: false, error: "busy", message: "A run is active in this conversation" };
  }
  const u = db.prepare(
    "SELECT id, parent_id, created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, seq DESC LIMIT 1",
  ).get(conversationId) as { id: string; parent_id: string | null; created_at: number } | undefined;
  if (!u) return { ok: false, error: "invalid_frame", message: "The conversation has no message to edit" };
  const ids = (db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND (id = ? OR created_at > ?)",
  ).all(conversationId, u.id, u.created_at) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    db.prepare("DELETE FROM metrics WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }
  // the head moves to the message before the removed one (none left: null); the rows are gone, so no stale head can be picked
  db.prepare("UPDATE conversations SET head_id = ?, updated_at = ?, seq = ? WHERE id = ?").run(lastMessageId(conversationId), Date.now(), nextSeq(), conversationId);
  broadcast(userId, { type: "upsert", conversations: [toConversation(getConversationRow(conversationId))] });
  return { ok: true };
}
