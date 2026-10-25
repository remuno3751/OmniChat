/* Checkpoints from inside VS Code (docs/design/V056E-CONTRACT.md §1): checkpoints_request -> checkpoints (the list, newest first, at
   most 50) and checkpoint_restore -> checkpoint_restored (the same rewind as POST /code/checkpoints/:id/rewind, code.ts). Only the
   conversations of this bridge that belong to the user (ownConversation). Dispatched from vscode-chat.ts. */
import { db, getMessageRow } from "./db.js";
import { isGenerating } from "./chat.js";
import { ownConversation } from "./vscode-chat-extra.js";
import { requestVscodeRewind, type RawFrame, type VscodeChatPeer } from "./vscode-bridge.js";

const MAX_CHECKPOINTS = 50;
const PROMPT_MAX = 120;

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length >= 1 && v.length <= 100 ? v : null);
const errorFrame = (peer: VscodeChatPeer, code: string, message: string, requestId?: string | null): void => {
  peer.reply({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
};

/** The user message just before the assistant message of a checkpoint: its text on one line, cut to 120 characters ("" when none). */
function promptBefore(conversationId: string, assistant: { id: string; created_at: number } | undefined): string {
  if (!assistant) return "";
  const u = db.prepare(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND id <> ? AND created_at <= ? ORDER BY created_at DESC, seq DESC LIMIT 1",
  ).get(conversationId, assistant.id, assistant.created_at) as { content?: string } | undefined;
  return String(u?.content ?? "").replace(/\s+/g, " ").trim().slice(0, PROMPT_MAX);
}

/** checkpoints_request -> checkpoints (`items`, newest first) or a not_found error frame. */
export function onCheckpoints(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "checkpoints_request needs requestId and conversationId", requestId); return; }
  if (!ownConversation(peer.userId, peer.bridge, id)) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  const rows = db.prepare(
    "SELECT * FROM checkpoints WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(peer.userId, id, MAX_CHECKPOINTS) as any[];
  const items = rows.map((r) => {
    const asst = r.message_id ? (getMessageRow(r.message_id) as any) : undefined;
    const changes = asst?.changes;
    let files = 0;
    try { const a = typeof changes === "string" && changes ? JSON.parse(changes) : null; files = Array.isArray(a) ? a.length : 0; } catch { files = 0; }
    return {
      id: r.id,
      createdAt: r.created_at,
      dirty: !!r.dirty,
      restorable: !!r.ref && !r.unavailable,
      prompt: promptBefore(id, asst && asst.conversation_id === id ? { id: asst.id, created_at: asst.created_at } : undefined),
      files,
      messageId: r.message_id ?? "",
    };
  });
  peer.reply({ type: "checkpoints", requestId, conversationId: id, items });
}

/** checkpoint_restore -> checkpoint_restored (ok, or error busy | unavailable | not_found | dirty_editors | failed). Waits for the bridge (<= 60 s). */
export async function onCheckpointRestore(peer: VscodeChatPeer, m: RawFrame): Promise<void> {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  const checkpointId = idOf(m.checkpointId);
  if (!requestId || !id || !checkpointId || (m.removeNew !== undefined && typeof m.removeNew !== "boolean")) {
    errorFrame(peer, "invalid_frame", "checkpoint_restore needs requestId, conversationId and checkpointId", requestId);
    return;
  }
  const reply = (ok: boolean, error?: string, message?: string): void => {
    peer.reply({ type: "checkpoint_restored", requestId, conversationId: id, checkpointId, ok, ...(error ? { error } : {}), ...(message ? { message } : {}) });
  };
  const conv = ownConversation(peer.userId, peer.bridge, id);
  if (!conv) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  const cp = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as any;
  if (!cp || cp.user_id !== peer.userId || cp.conversation_id !== id) { reply(false, "not_found"); return; }
  if (isGenerating(id) || conv.code_status === "running" || conv.code_status === "awaiting_approval") { reply(false, "busy"); return; }
  if (!cp.ref) { reply(false, "unavailable", cp.unavailable ? String(cp.unavailable).slice(0, 500) : undefined); return; }
  try {
    // the bridge keeps the current state under refs/omnichat/checkpoints/pre-rewind-<time> before it restores (gitops rewindTo)
    const r = await requestVscodeRewind(peer.userId, cp.bridge, cp.ref, cp.cwd ?? "", m.removeNew === true);
    if (r.ok) { reply(true); return; }
    if (r.error === "dirty_editors") { reply(false, "dirty_editors"); return; }
    reply(false, "failed", String(r.error ?? "rewind failed").slice(0, 500));
  } catch (e) {
    console.error("vscode checkpoint restore failed", e);
    reply(false, "failed", "rewind failed");
  }
}

/** Both checkpoint frames; a failure of the restore is answered, never thrown. */
export function onCheckpointFrame(peer: VscodeChatPeer, m: RawFrame): void {
  if (m.type === "checkpoints_request") { try { onCheckpoints(peer, m); } catch (e) { console.error("vscode checkpoints failed", e); errorFrame(peer, "internal", "Checkpoints failed", idOf(m.requestId)); } return; }
  onCheckpointRestore(peer, m).catch((e) => { console.error("vscode checkpoint restore failed", e); errorFrame(peer, "internal", "Checkpoint restore failed", idOf(m.requestId)); });
}
