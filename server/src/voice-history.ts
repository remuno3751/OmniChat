// Records an Aria voice call into the chat history (docs/design/ARIA-HOST.md 「履歴への記録」).
// Driven by Aria's JSON frames only, so it does not depend on what the client sends or shows.
import { randomUUID } from "node:crypto";
import { db, getConversationRow, getMessageRow, insertMessage, nextSeq, toConversation, toMessage, updateMessage, type Message } from "./db.js";
import { broadcast } from "./hub.js";

/** Text deltas are written and broadcast at most this often; turn end always flushes. */
const FLUSH_MS = 100;

/** Index of the last element matching `f`, or -1. */
function lastIndex<T>(a: T[], f: (x: T) => boolean): number {
  for (let k = a.length - 1; k >= 0; k--) if (f(a[k])) return k;
  return -1;
}

interface Streaming { id: string; turn: number | undefined; text: string; status: Message["status"] }

export class VoiceRecorder {
  /** user messages of this call, oldest first, with their Aria utterance_id and turn (for transcript_retract) */
  private users: { uid: string | undefined; turn: number | undefined; id: string }[] = [];
  private asst: Streaming | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private userId: string, private conversationId: string) {}

  onAriaMessage(msg: any): void {
    if (this.closed || !msg || typeof msg !== "object") return;
    try {
      const turn = typeof msg.turn === "number" ? msg.turn : undefined;
      const uid = typeof msg.utterance_id === "string" ? msg.utterance_id : undefined; // `<session>:<turn>`, unique per connection
      switch (msg.type) {
        case "transcript":
          if (msg.final === true && typeof msg.text === "string" && msg.text.trim()) this.addUser(uid, turn, msg.text);
          break;
        case "transcript_retract": this.retract(uid, turn); break;
        case "text": if (typeof msg.delta === "string") this.delta(turn, msg.delta); break;
        case "turn_end": if (this.asst && this.asst.turn === turn) this.finalize(msg.interrupted === true ? "stopped" : "done"); break;
        case "interrupted": if (this.asst && this.asst.turn === turn) this.finalize("stopped"); break;
      }
    } catch (e) {
      console.error("voice history failed", (e as Error).message);
    }
  }

  /** The call ended (either side). Any reply still streaming is kept as stopped. */
  finish(): void {
    if (this.closed) return;
    try { if (this.asst) this.finalize("stopped"); } catch (e) { console.error("voice history failed", (e as Error).message); }
    this.clearTimer();
    this.closed = true;
  }

  private addUser(uid: string | undefined, turn: number | undefined, text: string): void {
    const m = this.insert("user", text, "done", this.head());
    this.users.push({ uid, turn, id: m.id });
    this.publish(m, true);
  }

  /** Removes the user message of `uid` (else of `turn`, else the latest one). Its reply, if any, is kept and re-parented. */
  private retract(uid: string | undefined, turn: number | undefined): void {
    const i = uid !== undefined ? lastIndex(this.users, (u) => u.uid === uid)
      : turn !== undefined ? lastIndex(this.users, (u) => u.turn === turn)
      : this.users.length - 1;
    if (i < 0) return;
    const [u] = this.users.splice(i, 1);
    const row = getMessageRow(u.id);
    if (!row) return;
    const parent: string | null = row.parent_id ?? null;
    db.prepare("UPDATE messages SET parent_id = ? WHERE parent_id = ?").run(parent, u.id);
    db.prepare("DELETE FROM messages WHERE id = ?").run(u.id);
    // no delete frame exists: clients drop the row because the head no longer reaches it (same as an edit)
    db.prepare("UPDATE conversations SET head_id = CASE WHEN head_id = ? THEN ? ELSE head_id END, updated_at = ?, seq = ? WHERE id = ?")
      .run(u.id, parent, Date.now(), nextSeq(), this.conversationId);
    this.broadcastConversation();
  }

  private delta(turn: number | undefined, delta: string): void {
    if (this.asst && this.asst.turn !== turn) this.finalize("done");
    if (!this.asst) {
      const user = [...this.users].reverse().find((u) => u.turn === turn);
      const m = this.insert("assistant", "", "streaming", user?.id ?? this.head());
      this.asst = { id: m.id, turn, text: "", status: "streaming" };
      this.publish(m, true);
    }
    this.asst!.text += delta;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.write(); }, FLUSH_MS);
    this.timer.unref?.();
  }

  private finalize(status: Message["status"]): void {
    this.clearTimer();
    if (!this.asst) return;
    this.asst.status = status;
    this.write();
    this.asst = null;
  }

  private write(): void {
    if (!this.asst) return;
    const m = updateMessage(this.asst.id, this.asst.text, this.asst.status);
    this.publish(m, false);
  }

  private insert(role: "user" | "assistant", content: string, status: Message["status"], parentId: string | null): Message {
    const id = randomUUID();
    insertMessage(this.userId, { id, conversationId: this.conversationId, role, content, status, createdAt: Date.now(), parentId });
    db.prepare("UPDATE messages SET via = 'voice' WHERE id = ?").run(id);
    return toMessage(getMessageRow(id));
  }

  /** The conversation's head, else its latest message (same fallback as chat.ts). */
  private head(): string | null {
    const c = getConversationRow(this.conversationId);
    if (c?.head_id) return c.head_id;
    return (db.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1").get(this.conversationId) as { id: string } | undefined)?.id ?? null;
  }

  private publish(m: Message, moveHead: boolean): void {
    if (moveHead) db.prepare("UPDATE conversations SET head_id = ?, updated_at = ?, seq = ? WHERE id = ?").run(m.id, Date.now(), nextSeq(), this.conversationId);
    else db.prepare("UPDATE conversations SET updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), this.conversationId);
    broadcast(this.userId, { type: "upsert", conversations: [toConversation(getConversationRow(this.conversationId))], messages: [m] });
  }

  private broadcastConversation(): void {
    broadcast(this.userId, { type: "upsert", conversations: [toConversation(getConversationRow(this.conversationId))] });
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
