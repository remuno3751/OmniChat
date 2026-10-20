/* Attachments: storage, ownership, claim to a message, and the contract for the chat path (docs/design/ATTACHMENTS.md).
   Files: <DATA_DIR>/attachments/<userId>/<id> (bytes, unchanged) and <id>.txt (extracted text). Metadata: table attachments.
   Contract used by the chat path (chat.ts send, sync, context.ts) -- see docs/PROTOCOL-v7-attachments.md:
   getAttachmentRow, attachmentsForMessage, claimAttachments, loadAttachmentForModel, attachmentMeta, userUsage. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { db, nextSeq, restrictPerms, getMessageRow, toMessage } from "./db.js";
import { broadcast } from "./hub.js";
import { DATA_DIR } from "./config.js";
import { readAttachmentSettings } from "./attachments-settings.js";
import {
  AttachmentTypeError, detectType, sanitizeFileName, type AttachmentKind,
} from "./attachments-types.js";
import { extractAttachmentText, STORE_MAX_CHARS } from "./attachments-extract.js";
import { transcribeAudio } from "./attachments-transcribe.js";

const MB = 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type AttachmentStatus = "ready" | "deleted";

/** One row of the attachments table, camel-cased. Never sent to a client as is (use attachmentMeta). */
export interface AttachmentRecord {
  id: string;
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  /** file name of the extracted text inside the user's folder ("<id>.txt"), or null */
  textPath: string | null;
  /** characters of extracted text (the full count, even when the stored copy is cut); 0 when extraction failed; null for images and audio */
  textChars: number | null;
  transcript: string | null;
  status: AttachmentStatus;
  createdAt: number;
  deletedAt: number | null;
  seq: number;
}

/** What the model path receives (loadAttachmentForModel). */
export interface ModelAttachment {
  kind: AttachmentKind;
  mime: string;
  name: string;
  /** images only: data:<mime>;base64,... */
  dataUrl?: string;
  /** documents: extracted text; audio: transcript. Cut to extractMaxChars. */
  text?: string;
  /** present when text was cut: total characters and the characters shown */
  truncated?: { total: number; shown: number };
}

export interface AttachmentMeta {
  id: string; name: string; mime: string; kind: AttachmentKind; size: number; status: AttachmentStatus;
}

export type ClaimResult = { ok: true } | { ok: false; code: string; message: string };

export interface StoredUpload { rec: AttachmentRecord; warnings: string[] }

const toRecord = (r: any): AttachmentRecord => ({
  id: r.id,
  userId: r.user_id,
  conversationId: r.conversation_id ?? null,
  messageId: r.message_id ?? null,
  name: r.name,
  mime: r.mime,
  kind: r.kind,
  size: r.size,
  sha256: r.sha256,
  textPath: r.text_path ?? null,
  textChars: r.text_chars ?? null,
  transcript: r.transcript ?? null,
  status: r.status === "deleted" ? "deleted" : "ready",
  createdAt: r.created_at,
  deletedAt: r.deleted_at ?? null,
  seq: r.seq,
});

const root = (): string => join(DATA_DIR, "attachments");

/** The user's folder, created on demand (0700). */
export function userDir(userId: string): string {
  if (!USER_RE.test(userId)) throw new Error("invalid user id");
  const d = join(root(), userId);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  restrictPerms(d, 0o700);
  return d;
}

/** Path of the stored bytes of a row (not created). */
export const filePathOf = (rec: Pick<AttachmentRecord, "userId" | "id">): string => join(root(), rec.userId, rec.id);

/** Path of the extracted text of a row (not created), or null. */
export function textFileOf(rec: Pick<AttachmentRecord, "userId" | "textPath">): string | null {
  return rec.textPath ? join(root(), rec.userId, basename(rec.textPath)) : null;
}

/** The cut used for the model: never splits a surrogate pair. */
export function cutChars(s: string, n: number): string {
  if (s.length <= n) return s;
  let e = n;
  const c = s.charCodeAt(e - 1);
  if (c >= 0xd800 && c <= 0xdbff) e--;
  return s.slice(0, e);
}

export function getAttachmentRow(id: string): AttachmentRecord | undefined {
  if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
  const r = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
  return r ? toRecord(r) : undefined;
}

/** The attachments of one message in position order (message_attachments). Deleted ones are included (the message shows "(削除済み)"). */
export function attachmentsForMessage(messageId: string): AttachmentRecord[] {
  return (db.prepare(
    "SELECT a.* FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = ? ORDER BY ma.position, a.created_at, a.id",
  ).all(messageId) as any[]).map(toRecord);
}

/** A user's attachments, newest first; with a conversation id, only those claimed in that conversation. */
export function attachmentsOfUser(userId: string, conversationId?: string | null): AttachmentRecord[] {
  const rows = conversationId
    ? db.prepare("SELECT * FROM attachments WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC, id LIMIT 500").all(userId, conversationId)
    : db.prepare("SELECT * FROM attachments WHERE user_id = ? ORDER BY created_at DESC, id LIMIT 500").all(userId);
  return (rows as any[]).map(toRecord);
}

export function attachmentMeta(rec: AttachmentRecord): AttachmentMeta {
  return { id: rec.id, name: rec.name, mime: rec.mime, kind: rec.kind, size: rec.size, status: rec.status };
}

/** Bytes and count of a user's stored (ready) attachments, for the quota. */
export function userUsage(userId: string): { bytes: number; count: number } {
  const r = db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM attachments WHERE user_id = ? AND status = 'ready'").get(userId) as { bytes: number; count: number };
  return { bytes: Number(r.bytes), count: Number(r.count) };
}

/**
 * Stores an upload: size, name, type, quota, bytes on disk, text extraction, transcription, then the row.
 * Throws AttachmentTypeError (413 attachment_too_large, 415 attachment_type_not_allowed, 507 attachment_quota_exceeded).
 * Extraction and transcription failures do not throw: the attachment is kept and a warning comes back.
 */
export async function storeUpload(userId: string, rawName: string | undefined, buf: Buffer): Promise<StoredUpload> {
  const st = readAttachmentSettings();
  if (buf.length > st.maxFileMB * MB) throw new AttachmentTypeError(413, "attachment_too_large", `the file is larger than ${st.maxFileMB} MB`);
  const name = sanitizeFileName(rawName);
  const type = await detectType(name, buf);
  if (st.quotaMB > 0 && userUsage(userId).bytes + buf.length > st.quotaMB * MB) {
    throw new AttachmentTypeError(507, "attachment_quota_exceeded", `the storage quota of ${st.quotaMB} MB is full`);
  }

  const id = randomUUID();
  const dir = userDir(userId);
  const path = join(dir, id);
  const warnings: string[] = [];
  let textPath: string | null = null;
  let textChars: number | null = null;
  let transcript: string | null = null;
  writeFileSync(path, buf, { mode: 0o600 });
  try {
    if (type.kind === "document") {
      const out = await extractAttachmentText(type, buf);
      if (out.warning) warnings.push(out.warning);
      if (out.text !== null) {
        textChars = out.text.length;
        const stored = out.text.length > STORE_MAX_CHARS ? cutChars(out.text, STORE_MAX_CHARS) : out.text;
        writeFileSync(join(dir, `${id}.txt`), stored, { mode: 0o600 });
        textPath = `${id}.txt`;
      }
    } else if (type.kind === "audio") {
      if (st.transcribeModel) {
        const tr = await transcribeAudio(userId, st.transcribeModel, buf, name, type.mime);
        if (tr.warning) warnings.push(tr.warning);
        transcript = tr.text ?? null;
      } else {
        warnings.push("音声は保存されましたが、文字起こしのモデルが未設定のため、AI には渡せません");
      }
    }
    const createdAt = Date.now();
    const seq = nextSeq();
    db.prepare(
      "INSERT INTO attachments (id, user_id, conversation_id, message_id, name, mime, kind, size, sha256, text_path, text_chars, transcript, status, created_at, deleted_at, seq) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, NULL, ?)",
    ).run(id, userId, name, type.mime, type.kind, buf.length, createHash("sha256").update(buf).digest("hex"), textPath, textChars, transcript, createdAt, seq);
    const rec = getAttachmentRow(id)!;
    return { rec, warnings };
  } catch (e) {
    removeFiles({ userId, id, textPath });
    throw e;
  }
}

/** Deletes the bytes and the extracted text of a row (missing files are fine). */
export function removeFiles(rec: { userId: string; id: string; textPath: string | null }): void {
  for (const p of [filePathOf(rec), textFileOf(rec)]) {
    if (!p) continue;
    try { rmSync(p, { force: true }); } catch { /* already gone or locked: the row is marked deleted anyway */ }
  }
}

/** Marks a row deleted and removes its files. The row stays, so a message can show "(削除済み)". */
export function deleteAttachment(rec: AttachmentRecord, now = Date.now()): void {
  removeFiles(rec);
  db.prepare("UPDATE attachments SET status = 'deleted', deleted_at = ? WHERE id = ? AND status = 'ready'").run(now, rec.id);
  announceDeletion(rec);
}

/** The messages that show this attachment get a new seq and are sent again, so every device shows "(deleted)". Best effort. */
function announceDeletion(rec: AttachmentRecord): void {
  try {
    const rows = db.prepare("SELECT m.id AS id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id = ?").all(rec.id) as { id: string }[];
    for (const r of rows) db.prepare("UPDATE messages SET seq = ? WHERE id = ?").run(nextSeq(), r.id);
    const msgs = rows.map((r) => getMessageRow(r.id)).filter(Boolean).map((m) => toMessage(m));
    if (msgs.length) broadcast(rec.userId, { type: "upsert", messages: msgs });
  } catch { /* the deletion itself already happened */ }
}

export type ClaimCheck = { ok: true; recs: AttachmentRecord[] } | { ok: false; code: string; message: string };

/** The claim rules without writing anything: shape, count, owner, ready, same conversation (or unattached). */
export function checkClaim(userId: string, ids: unknown, conversationId: string): ClaimCheck {
  const fail = (code: string, message: string): ClaimCheck => ({ ok: false, code, message });
  if (!Array.isArray(ids)) return fail("attachment_invalid", "attachmentIds must be an array");
  if (ids.some((x) => typeof x !== "string")) return fail("attachment_invalid", "attachmentIds must be strings");
  if (new Set(ids).size !== ids.length) return fail("attachment_invalid", "duplicate attachment id");
  const max = readAttachmentSettings().maxPerMessage;
  if (ids.length > max) return fail("attachment_too_many", `at most ${max} attachments per message`);
  const recs: AttachmentRecord[] = [];
  for (const id of ids as string[]) {
    const rec = getAttachmentRow(id);
    if (!rec || rec.userId !== userId) return fail("attachment_not_found", "attachment not found");
    if (rec.status !== "ready") return fail("attachment_deleted", "attachment was deleted");
    if (rec.conversationId && rec.conversationId !== conversationId) return fail("attachment_already_attached", "attachment is already attached to another conversation");
    recs.push(rec);
  }
  return { ok: true, recs };
}

/**
 * Attaches uploaded attachments to a new message (table message_attachments, with positions). Checks: a list of unique ids,
 * at most maxPerMessage, each owned by userId, ready, and either unattached or already used in the same conversation
 * (so an edited message can reuse them). All or nothing.
 */
export function claimAttachments(userId: string, ids: unknown, conversationId: string, messageId: string): ClaimResult {
  if (Array.isArray(ids) && ids.length === 0) return { ok: true };
  // Validation and the update run in one synchronous block (the sqlite connection is synchronous), so nothing interleaves.
  db.exec("BEGIN");
  try {
    const chk = checkClaim(userId, ids, conversationId);
    if (!chk.ok) { db.exec("ROLLBACK"); return chk; }
    const ins = db.prepare("INSERT OR IGNORE INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)");
    const upd = db.prepare("UPDATE attachments SET conversation_id = COALESCE(conversation_id, ?), message_id = COALESCE(message_id, ?) WHERE id = ? AND user_id = ?");
    (ids as string[]).forEach((id, i) => { ins.run(messageId, id, i); upd.run(conversationId, messageId, id, userId); });
    db.exec("COMMIT");
    return { ok: true };
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    return { ok: false, code: "attachment_invalid", message: "could not attach the files" };
  }
}

/**
 * What the model gets for one attachment. Images: a data URL (the caller must only send it to a model that reads images).
 * Documents: the extracted text. Audio: the transcript (no text when there is none). Both cut to extractMaxChars.
 * Returns null for a deleted row or a missing file.
 */
export function loadAttachmentForModel(rec: AttachmentRecord): ModelAttachment | null {
  if (rec.status !== "ready") return null;
  const path = filePathOf(rec);
  if (!existsSync(path)) return null;
  if (rec.kind === "image") {
    const b = readFileSync(path);
    return { kind: rec.kind, mime: rec.mime, name: rec.name, dataUrl: `data:${rec.mime};base64,${b.toString("base64")}` };
  }
  const max = readAttachmentSettings().extractMaxChars;
  let full: string | undefined;
  let total: number;
  if (rec.kind === "document") {
    const tf = textFileOf(rec);
    full = tf && existsSync(tf) ? readFileSync(tf, "utf8") : "";
    total = rec.textChars ?? full.length;
  } else {
    if (rec.transcript === null) return { kind: rec.kind, mime: rec.mime, name: rec.name };
    full = rec.transcript;
    total = full.length;
  }
  const shown = cutChars(full, max);
  return {
    kind: rec.kind,
    mime: rec.mime,
    name: rec.name,
    text: shown,
    ...(total > shown.length ? { truncated: { total, shown: shown.length } } : {}),
  };
}

/** Owner-only read of the bytes of a stored row (the route checks the owner). */
export function readAttachmentBytes(rec: AttachmentRecord): Buffer {
  return readFileSync(filePathOf(rec));
}
