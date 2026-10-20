/* Attachment settings (docs/design/ATTACHMENTS.md "上限と形式"): server-wide, stored in server_settings under key "attachments".
   Read by the upload path, the retention job and the model loader. Written by PUT /admin/attachments (validated strictly). */
import { db } from "./db.js";
import { AuthError } from "./auth.js";
import { recordAudit, type Actor } from "./admin-core.js";

export interface AttachmentSettings {
  /** 1 file, in MB */
  maxFileMB: number;
  /** per user, in MB; 0 = unlimited */
  quotaMB: number;
  /** 0 = keep forever; N = delete ready attachments N days after upload */
  retentionDays: number;
  maxPerMessage: number;
  /** characters of extracted text handed to the model */
  extractMaxChars: number;
  /** "<providerId>::<model>" used for audio transcription; null = audio is kept but not sent to the model */
  transcribeModel: string | null;
}

export const ATTACHMENT_DEFAULTS: AttachmentSettings = {
  maxFileMB: 25,
  quotaMB: 2048,
  retentionDays: 0,
  maxPerMessage: 10,
  extractMaxChars: 60000,
  transcribeModel: null,
};

/** Inclusive integer ranges for the numeric fields. */
export const ATTACHMENT_RANGES: Record<"maxFileMB" | "quotaMB" | "retentionDays" | "maxPerMessage" | "extractMaxChars", [number, number]> = {
  maxFileMB: [1, 500],
  quotaMB: [0, 1_000_000],
  retentionDays: [0, 3650],
  maxPerMessage: [1, 50],
  extractMaxChars: [1000, 500_000],
};

const KEY = "attachments";
const CONTROL_CHARS = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex
const MODEL_REF = /^([A-Za-z0-9_.-]{1,80})::([^\x00-\x1f\x7f]{1,300})$/;

export type AttachmentPatch = Partial<AttachmentSettings>;

const inRange = (v: unknown, [lo, hi]: [number, number]): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;

function readStored(): Record<string, unknown> {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** The effective settings: stored values that pass validation, else the defaults (a bad stored value never breaks uploads). */
export function readAttachmentSettings(): AttachmentSettings {
  const s = readStored();
  const out: AttachmentSettings = { ...ATTACHMENT_DEFAULTS };
  for (const k of Object.keys(ATTACHMENT_RANGES) as (keyof typeof ATTACHMENT_RANGES)[]) {
    if (inRange(s[k], ATTACHMENT_RANGES[k])) out[k] = s[k] as number;
  }
  if (s.transcribeModel === null) out.transcribeModel = null;
  else if (typeof s.transcribeModel === "string" && MODEL_REF.test(s.transcribeModel)) out.transcribeModel = s.transcribeModel;
  return out;
}

/** PUT /admin/attachments body: partial and strict. Throws AuthError(400) on any problem. */
export function parseAttachmentPatch(body: unknown): AttachmentPatch {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) throw new AuthError("empty body", 400);
  const patch: AttachmentPatch = {};
  for (const k of keys) {
    const v = b[k];
    if (k === "transcribeModel") {
      if (v === null) { patch.transcribeModel = null; continue; }
      if (typeof v !== "string" || !MODEL_REF.test(v)) throw new AuthError("transcribeModel must be null or \"<providerId>::<model>\"", 400);
      patch.transcribeModel = v;
    } else if (k in ATTACHMENT_RANGES) {
      const key = k as keyof typeof ATTACHMENT_RANGES;
      const [lo, hi] = ATTACHMENT_RANGES[key];
      if (!inRange(v, [lo, hi])) throw new AuthError(`${k} must be an integer from ${lo} to ${hi}`, 400);
      patch[key] = v;
    } else {
      throw new AuthError(`unknown field: ${k}`, 400);
    }
  }
  return patch;
}

/** PUT /admin/attachments: validates, writes the merged value, audits one row per changed key. */
export function updateAttachments(actor: Actor, body: unknown): AttachmentSettings {
  const patch = parseAttachmentPatch(body);
  const before = readAttachmentSettings();
  const stored = readStored();
  const next = { ...before, ...patch };
  if (CONTROL_CHARS.test(String(next.transcribeModel ?? ""))) throw new AuthError("transcribeModel is invalid", 400);
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify({ ...stored, ...next }), Date.now());
  for (const k of Object.keys(patch) as (keyof AttachmentSettings)[]) {
    if (before[k] !== next[k]) recordAudit(actor, "attachments.update", k, before[k], next[k]);
  }
  return readAttachmentSettings();
}
