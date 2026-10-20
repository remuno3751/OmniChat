/* Automatic deletion of attachments (docs/design/ATTACHMENTS.md "自動削除").
   retentionDays > 0: ready attachments older than N days are deleted (files and text), and so are unattached ones older than 24 h.
   retentionDays = 0 (default): ready attachments are kept for ever, but unattached ones (an upload never sent with a message) are still removed after 24 h. */
import { db } from "./db.js";
import { readAttachmentSettings } from "./attachments-settings.js";
import { rmdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { deleteAttachment, type AttachmentRecord } from "./attachments.js";

const DAY = 24 * 60 * 60 * 1000;
const UNATTACHED_MS = DAY;
const JOB_EVERY_MS = 6 * 60 * 60 * 1000;

const rowsWhere = (sql: string, ...args: unknown[]): AttachmentRecord[] =>
  (db.prepare(sql).all(...(args as never[])) as any[]).map((r) => ({
    id: r.id, userId: r.user_id, conversationId: r.conversation_id ?? null, messageId: r.message_id ?? null,
    name: r.name, mime: r.mime, kind: r.kind, size: r.size, sha256: r.sha256, textPath: r.text_path ?? null,
    textChars: r.text_chars ?? null, transcript: r.transcript ?? null, status: "ready" as const,
    createdAt: r.created_at, deletedAt: null, seq: r.seq,
  }));

/** One pass. `now` is passed in so tests can move time. Returns how many rows were deleted per reason. */
export function runRetention(now: number = Date.now()): { expired: number; unattached: number } {
  const days = readAttachmentSettings().retentionDays;
  const expired = !(days > 0) ? [] : rowsWhere("SELECT * FROM attachments WHERE status = 'ready' AND created_at < ?", now - days * DAY);
  const unattached = rowsWhere("SELECT * FROM attachments WHERE status = 'ready' AND message_id IS NULL AND created_at < ?", now - UNATTACHED_MS);
  const seen = new Set<string>();
  let nExpired = 0;
  let nUnattached = 0;
  for (const r of expired) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deleteAttachment(r, now);
    nExpired++;
  }
  for (const r of unattached) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deleteAttachment(r, now);
    nUnattached++;
  }
  return { expired: nExpired, unattached: nUnattached };
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Runs once now, then every 6 hours. The timer is unref'd so it never keeps the process alive. Errors are swallowed. */
export function startRetentionJob(): void {
  const tick = () => { try { runRetention(Date.now()); } catch { /* best effort; the next tick retries */ } };
  tick();
  if (!timer) {
    timer = setInterval(tick, JOB_EVERY_MS);
    timer.unref?.();
  }
}

export function stopRetentionJob(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Deletes every ready attachment of a user (files and text), and the folder when it is empty. For account deletion. */
export function deleteAttachmentsOfUser(userId: string): number {
  const rows = rowsWhere("SELECT * FROM attachments WHERE user_id = ? AND status = 'ready'", userId);
  for (const r of rows) deleteAttachment(r);
  try { rmdirSync(join(DATA_DIR, "attachments", userId)); } catch { /* not empty or missing */ }
  return rows.length;
}

/** Ready attachments of ids that still have a link to a live message of a conversation other than `exceptConv` (and other than `exceptMsg`). */
const stillUsed = (attachmentId: string, exceptConv: string | null, exceptMsg: string | null): boolean =>
  !!db.prepare(
    "SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN conversations c ON c.id = m.conversation_id " +
    "WHERE ma.attachment_id = ? AND c.deleted = 0 AND (? IS NULL OR c.id <> ?) AND (? IS NULL OR m.id <> ?) LIMIT 1",
  ).get(attachmentId, exceptConv, exceptConv, exceptMsg, exceptMsg);

/**
 * Deletes the ready attachments attached to a conversation (files and text), except those that are also attached to a message
 * of another live (not deleted) conversation. For conversation deletion (soft or hard).
 */
export function deleteAttachmentsOfConversation(conversationId: string): number {
  const rows = rowsWhere(
    "SELECT DISTINCT a.* FROM attachments a WHERE a.status = 'ready' AND (a.conversation_id = ? OR a.id IN " +
    "(SELECT ma.attachment_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.conversation_id = ?))",
    conversationId, conversationId,
  );
  let n = 0;
  for (const r of rows) {
    if (stillUsed(r.id, conversationId, null)) continue;
    deleteAttachment(r);
    n++;
  }
  return n;
}

/**
 * Deletes the attachments of one message that no other live message uses, and removes the message's message_attachments rows.
 * For message deletion.
 */
export function deleteAttachmentsOfMessage(messageId: string): number {
  const rows = rowsWhere(
    "SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id = a.id WHERE ma.message_id = ? AND a.status = 'ready'",
    messageId,
  );
  let n = 0;
  for (const r of rows) {
    if (stillUsed(r.id, null, messageId)) continue;
    deleteAttachment(r);
    n++;
  }
  db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(messageId);
  return n;
}
