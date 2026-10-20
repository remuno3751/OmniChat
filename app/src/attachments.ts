// Pure helpers for chat attachments (PROTOCOL-v7). No React / RN imports, so they are unit-tested.

/** Show an image inline only when it is at most this big; larger ones get a placeholder until opened. */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type AttachKind = 'image' | 'document' | 'audio' | 'other';
export type Vision = 'yes' | 'no' | 'unknown';

/** One chip above the composer. `localId` is client-only; `id` is the server id once uploaded. */
export interface Chip {
  localId: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachKind;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  id?: string;
  errorCode?: string;
  errorMessage?: string;
  warnings: string[];
}

/** "512 B", "1.5 KB", "3.2 MB", "1.2 GB" (1024-based). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** The i18n key for a server error code (413 / 415 / 507 and the rest). */
export function attachErrorKey(code?: string): string {
  switch (code) {
    case 'attachment_too_large': return 'attach.err.tooLarge';
    case 'attachment_type_not_allowed': return 'attach.err.type';
    case 'attachment_quota_exceeded': return 'attach.err.quota';
    case 'attachment_too_many': return 'attach.err.tooMany';
    case 'attachment_not_found':
    case 'attachment_deleted': return 'attach.err.gone';
    default: return 'attach.err.generic';
  }
}

export function visionKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

/** Vision of a model: the user/admin override wins, else what the model list said, else unknown. */
export function effectiveVision(providerId: string, model: string, listed: Vision | undefined, overrides: Record<string, boolean> | null | undefined): Vision {
  const o = overrides?.[visionKey(providerId, model)];
  if (o === true) return 'yes';
  if (o === false) return 'no';
  return listed ?? 'unknown';
}

/**
 * The warning under the chips when images are attached: null (no warning) when the model reads images,
 * 'unknown' (may not read them; also when not known yet), 'no' (does not support images).
 */
export function imageWarning(vision: Vision | undefined, hasImageChip: boolean): null | 'unknown' | 'no' {
  if (!hasImageChip || vision === 'yes') return null;
  return vision === 'no' ? 'no' : 'unknown';
}

/**
 * Audio is not sent to the model without a transcription model. `transcribeModel` is null only when the
 * admin settings were read and nothing is set; undefined (not an admin / not read) gives no local note,
 * the server's own warning is shown instead.
 */
export function audioNote(kind: AttachKind, transcribeModel: string | null | undefined): boolean {
  return kind === 'audio' && transcribeModel === null;
}

/** How many of `incoming` fit under `max` next to `existing`: the rest are dropped (and reported). */
export function capSelection(existing: number, incoming: number, max: number): { take: number; dropped: number } {
  const room = Math.max(0, max - existing);
  const want = Math.max(0, incoming);
  const take = Math.min(room, want);
  return { take, dropped: want - take };
}

export function readyIds(chips: Chip[]): string[] {
  return chips.filter((c) => c.status === 'ready' && c.id).map((c) => c.id as string);
}

/** Sending is off while any file is still uploading. */
export function canSendAttachments(chips: Chip[]): boolean {
  return !chips.some((c) => c.status === 'uploading');
}

export function hasImage(chips: Chip[]): boolean {
  return chips.some((c) => c.kind === 'image' && c.status !== 'error');
}

export function hasAudio(chips: Chip[]): boolean {
  return chips.some((c) => c.kind === 'audio' && c.status !== 'error');
}

/** Chip transitions. */
export function chipUploaded(chip: Chip, id: string, warnings: string[]): Chip {
  return { ...chip, status: 'ready', progress: 1, id, warnings };
}
export function chipProgress(chip: Chip, progress: number): Chip {
  return chip.status === 'uploading' ? { ...chip, progress: Math.max(0, Math.min(1, progress)) } : chip;
}
export function chipFailed(chip: Chip, code: string | undefined, message: string | undefined): Chip {
  return { ...chip, status: 'error', errorCode: code, errorMessage: message, progress: 0 };
}

/** Kind from the MIME type (the server decides the real kind; this only gives the first look). */
export function kindFromMime(mime: string): AttachKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m.includes('officedocument') || m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'document';
  return 'other';
}

/**
 * Code (dsh-bridge) conversations: the bridge takes only the text of documents. Images and audio are refused
 * (the bridge run frame has no image or audio field; docs/design/ATTACHMENTS.md, "Code / DSH での添付").
 */
export function codeRefusesKind(kind: AttachKind): boolean {
  return kind === 'image' || kind === 'audio';
}

/** The picked files a Code conversation can take, and how many it refuses. Outside Code nothing is refused. */
export function splitForCode<T extends { mime: string }>(files: T[], codeMode: boolean): { allowed: T[]; refused: number } {
  if (!codeMode) return { allowed: files, refused: 0 };
  const allowed = files.filter((f) => !codeRefusesKind(kindFromMime(f.mime)));
  return { allowed, refused: files.length - allowed.length };
}

/** A chip that the Code send cannot carry (an image or audio chip that did not fail). The chip shows the warning. */
export function codeChipRefused(c: Chip, codeMode: boolean): boolean {
  return codeMode && codeRefusesKind(c.kind) && c.status !== 'error';
}

/** The send is held while a Code conversation has a refused chip. */
export function codeSendBlocked(chips: Chip[], codeMode: boolean): boolean {
  return chips.some((c) => codeChipRefused(c, codeMode));
}
