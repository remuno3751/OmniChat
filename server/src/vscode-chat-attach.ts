/* Attachments of a vscode-bridge prompt (docs/design/V055-CONTRACT.md, "prompt.attachments"). The extension sends the files
   as base64; they are checked here, stored with the normal attachment store, and their ids go to handleSend.
   Nothing is kept when the prompt is refused: every file stored so far is deleted again. */
import { deleteAttachment, storeUpload, type AttachmentRecord } from "./attachments.js";
import { AttachmentTypeError, detectType, sanitizeFileName } from "./attachments-types.js";
import { visionOfModelRef } from "./attachments-chat.js";
import type { VisionSupport } from "./vision.js";

export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
/** base64 length of MAX_FILE_BYTES: longer strings are refused before decoding */
const MAX_B64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;
/** base64 alphabet, optional padding; checked flat (a grouped pattern overflows the stack on megabyte strings) */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64 = (s: string): boolean => s.length % 4 === 0 && BASE64.test(s);

export type PrepareError = "attachment_invalid" | "attachment_too_large" | "attachment_not_supported";
export type PrepareResult = { ok: true; ids: string[] } | { ok: false; error: PrepareError; message: string };

/** The outside calls, injectable for tests. */
export interface PrepareDeps {
  /** vision of the conversation's real model ("<providerId>::<model>") */
  vision: (userId: string, modelRef: string) => Promise<VisionSupport>;
  store: (userId: string, rawName: string, buf: Buffer) => Promise<{ rec: AttachmentRecord }>;
  remove: (rec: AttachmentRecord) => void;
}

const realDeps: PrepareDeps = {
  vision: visionOfModelRef,
  store: storeUpload,
  remove: (rec) => deleteAttachment(rec),
};

const bad = (message: string): PrepareResult => ({ ok: false, error: "attachment_invalid", message });
const tooLarge = (message: string): PrepareResult => ({ ok: false, error: "attachment_too_large", message });
const notSupported = (message: string): PrepareResult => ({ ok: false, error: "attachment_not_supported", message });

/**
 * Validates and stores the attachments of one prompt. `raw` is the `attachments` field of the prompt (absent = none).
 * Images need a real model with vision "yes"; audio is refused. Everything is checked before the first file is stored,
 * except the store itself: a failure there deletes the files stored so far.
 */
export async function prepareAttachments(
  userId: string,
  modelRef: string,
  raw: unknown,
  deps: Partial<PrepareDeps> = {},
): Promise<PrepareResult> {
  const d: PrepareDeps = { ...realDeps, ...deps };
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return bad("attachments must be an array");
  if (raw.length === 0) return { ok: true, ids: [] };
  if (raw.length > MAX_FILES) return bad(`at most ${MAX_FILES} files`);

  // shape, base64 and sizes
  const files: { name: string; buf: Buffer }[] = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") return bad("each attachment must be an object");
    const { name, mime, data } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof mime !== "string" || typeof data !== "string") return bad("each attachment needs name, mime and data as strings");
    if (name.length > 1000 || mime.length > 200) return bad("the name or mime of an attachment is too long");
    if (data.length > MAX_B64_CHARS) return tooLarge(`each file may be at most ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    if (!isBase64(data)) return bad("the data of an attachment is not valid base64");
    const buf = Buffer.from(data, "base64");
    if (buf.length > MAX_FILE_BYTES) return tooLarge(`each file may be at most ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) return tooLarge(`the files together may be at most ${MAX_TOTAL_BYTES / 1024 / 1024} MiB`);
    files.push({ name, buf });
  }

  // what the bytes are (the client's name and mime are not trusted); images need vision, audio is refused
  let images = 0;
  try {
    for (const f of files) {
      const t = await detectType(sanitizeFileName(f.name), f.buf);
      if (t.kind === "audio") return notSupported("audio attachments are not supported in Code");
      if (t.kind === "image") images++;
    }
    if (images && (await d.vision(userId, modelRef)) !== "yes") return notSupported("this model cannot read images");
  } catch (e) {
    return bad(e instanceof AttachmentTypeError ? e.message : `attachment check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // store; on any failure delete what is already stored
  const stored: AttachmentRecord[] = [];
  try {
    for (const f of files) stored.push((await d.store(userId, f.name, f.buf)).rec);
  } catch (e) {
    for (const rec of stored) {
      try { d.remove(rec); } catch { /* best effort: the other files are still removed */ }
    }
    if (e instanceof AttachmentTypeError && e.code === "attachment_too_large") return tooLarge(e.message);
    return bad(e instanceof Error ? e.message : String(e));
  }
  return { ok: true, ids: stored.map((r) => r.id) };
}
