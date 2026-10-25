/**
 * Attachment rules for prompts: the limits the extension and the server share, the structural check
 * of a webview message, and the host-side pre-check that explains a refusal with a toast. Pure, no
 * `vscode` import. The server enforces the same limits and answers `attachment_*` codes as well.
 */
import type { PromptAttachment } from "../protocol/chat-frames";
import type { InputStrings } from "../ui/stringsInput";

const MIB = 1024 * 1024;

export const ATTACH_LIMITS = {
  maxFiles: 4,
  maxFileBytes: 4 * MIB,
  maxTotalBytes: 5 * MIB,
  imageMimes: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
} as const;

/** Structural caps for a message from the webview. Looser than ATTACH_LIMITS, so the toasts can explain a refusal. */
const MAX_WIRE_FILES = 16;
const MAX_WIRE_DATA_CHARS = 8 * MIB;
const MAX_NAME_CHARS = 255;
const MAX_MIME_CHARS = 127;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size in bytes of a base64 string (padding removed). */
export function decodedBytes(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

/**
 * Validates the `attachments` field of a webview message. Absent means none (an empty list).
 * Returns null when the field is present but malformed or beyond the structural caps.
 */
export function parseAttachments(v: unknown): PromptAttachment[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_WIRE_FILES) return null;
  const out: PromptAttachment[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== "string" || a.name === "" || a.name.length > MAX_NAME_CHARS) return null;
    if (typeof a.mime !== "string" || a.mime === "" || a.mime.length > MAX_MIME_CHARS) return null;
    if (typeof a.data !== "string" || a.data === "" || a.data.length > MAX_WIRE_DATA_CHARS) return null;
    if (!BASE64_RE.test(a.data)) return null;
    out.push({ name: a.name, mime: a.mime, data: a.data });
  }
  return out;
}

/** Vision of the attachments' model: true, false, or null when unknown (the server decides then). */
export type VisionOk = boolean | null;

export type AttachCheck = { ok: true } | { ok: false; toast: string };

/**
 * Host-side pre-check before a prompt is sent. The first failing rule gives the toast text:
 * too many files, a type that cannot be attached (audio, or an image format the server refuses),
 * an image for a model without vision, a file over the per-file cap, or a total over the cap.
 */
export function checkAttachments(list: readonly PromptAttachment[], visionOk: VisionOk, s: InputStrings): AttachCheck {
  if (list.length > ATTACH_LIMITS.maxFiles) {
    return { ok: false, toast: s.attachTooMany.replace("{n}", String(ATTACH_LIMITS.maxFiles)) };
  }
  let total = 0;
  for (const a of list) {
    const mime = a.mime.toLowerCase();
    const isImage = mime.startsWith("image/");
    if (mime.startsWith("audio/") || (isImage && !(ATTACH_LIMITS.imageMimes as readonly string[]).includes(mime))) {
      return { ok: false, toast: s.attachBadType.replace("{name}", a.name) };
    }
    if (isImage && visionOk === false) return { ok: false, toast: s.attachNoVision };
    const bytes = decodedBytes(a.data);
    if (bytes > ATTACH_LIMITS.maxFileBytes) {
      return { ok: false, toast: s.attachTooBig.replace("{name}", a.name).replace("{mb}", String(ATTACH_LIMITS.maxFileBytes / MIB)) };
    }
    total += bytes;
  }
  if (total > ATTACH_LIMITS.maxTotalBytes) {
    return { ok: false, toast: s.attachTotalBig.replace("{mb}", String(ATTACH_LIMITS.maxTotalBytes / MIB)) };
  }
  return { ok: true };
}
