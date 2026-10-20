// Client state of the composer's attachments (PROTOCOL-v7): the chips, the upload, and the hand-over to the send.
// Module-level store (like contextState.ts) so the chat screen, the socket layer and the settings can share it.
import { useSyncExternalStore } from 'react';
import { ApiError, deleteAttachment, uploadAttachment, getAdminAttachments, listAttachments } from './api';
import { attachErrorKey, capSelection, chipFailed, chipProgress, chipUploaded, kindFromMime, readyIds, type Chip } from './attachments';

/** A file the user picked: a Blob (web), or a file URI (native; read into a Blob at upload). */
export interface PickedFile { name: string; mime: string; size: number; blob?: Blob; uri?: string }

/** Limits from the admin settings; the non-admin defaults are the server defaults. */
export interface AttachLimits { maxPerMessage: number; maxFileMB: number; transcribeModel: string | null | undefined }
const DEFAULT_LIMITS: AttachLimits = { maxPerMessage: 10, maxFileMB: 25, transcribeModel: undefined };

type Listener = () => void;
const listeners = new Set<Listener>();
let chips: Chip[] = [];
/** the chips of the last send, kept so a refused send can put them back */
let lastSent: Chip[] = [];
let staged: string[] | null = null;
let limits: AttachLimits = DEFAULT_LIMITS;
let limitsKnown = false;
let checked = false;
/** false on a server without attachments (its routes answer 404): the UI then shows nothing */
let supported = true;
let overrides: Record<string, boolean> | null = null;
let seq = 0;

const emit = () => listeners.forEach((f) => f());
const subscribe = (f: Listener) => { listeners.add(f); return () => { listeners.delete(f); }; };
const setChips = (next: Chip[]) => { chips = next; emit(); };
const patch = (localId: string, f: (c: Chip) => Chip) => setChips(chips.map((c) => (c.localId === localId ? f(c) : c)));

export function useChips(): Chip[] { return useSyncExternalStore(subscribe, () => chips, () => chips); }
export function getChips(): Chip[] { return chips; }
export function useLimits(): AttachLimits { return useSyncExternalStore(subscribe, () => limits, () => limits); }
export function useAttachSupport(): boolean { return useSyncExternalStore(subscribe, () => supported, () => supported); }
export function useVisionOverrides(): Record<string, boolean> | null { return useSyncExternalStore(subscribe, () => overrides, () => overrides); }

/** Keep the per-model vision overrides in step with the server settings (and after a change). */
export function setVisionOverrides(next: Record<string, boolean> | null | undefined) { overrides = next ?? null; emit(); }

/** Admins read the real limits; everyone else keeps the defaults (the server enforces them anyway). */
export async function loadLimits(isAdmin: boolean): Promise<void> {
  if (checked) return;
  checked = true;
  try {
    if (isAdmin) {
      const s = await getAdminAttachments();
      limits = { maxPerMessage: s.maxPerMessage, maxFileMB: s.maxFileMB, transcribeModel: s.transcribeModel ?? null };
      limitsKnown = true;
    } else {
      await listAttachments();
    }
  } catch (e: any) {
    // 404: an old server without attachments; the attach UI is hidden. Other errors keep the defaults.
    if (e instanceof ApiError && e.status === 404) supported = false;
    checked = false;
  }
  emit();
}

/**
 * Add picked files as chips and upload them. Files past `maxPerMessage` are not added; the number dropped is returned.
 * Each chip reports its progress and, on failure, the server's code.
 */
export function addPicked(files: PickedFile[]): { dropped: number } {
  const { take, dropped } = capSelection(chips.length, files.length, limits.maxPerMessage);
  const picked = files.slice(0, take);
  const fresh: Chip[] = picked.map((f) => ({
    localId: `att${Date.now()}${seq++}`, name: f.name, size: f.size, mime: f.mime, kind: kindFromMime(f.mime),
    status: 'uploading', progress: 0, warnings: [],
  }));
  setChips([...chips, ...fresh]);
  picked.forEach((f, i) => { void uploadOne(fresh[i].localId, f); });
  return { dropped };
}

async function uploadOne(localId: string, f: PickedFile) {
  try {
    let body: Blob | undefined = f.blob;
    if (!body && f.uri) body = await (await fetch(f.uri)).blob();
    if (!body) throw new ApiError('no file', 0);
    const r = await uploadAttachment(body, f.name, f.mime, (frac) => patch(localId, (c) => chipProgress(c, frac)));
    patch(localId, (c) => chipUploaded({ ...c, kind: (r.attachment.kind as Chip['kind']) || c.kind, name: r.attachment.name || c.name }, r.attachment.id, r.warnings));
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : undefined;
    patch(localId, (c) => chipFailed(c, code, e?.message));
  }
}

/** Remove a chip; an uploaded file is deleted on the server too (best effort). */
export function removeChip(localId: string) {
  const c = chips.find((x) => x.localId === localId);
  setChips(chips.filter((x) => x.localId !== localId));
  if (c?.id) void deleteAttachment(c.id).catch(() => {});
}

/** The ids of the ready chips, for the next `send` (the socket layer adds them to the frame). */
export function readyAttachmentIds(): string[] { return readyIds(chips); }

/** Stage the ids for the next send frame; wsSend consumes them once. */
export function stageSendAttachments(ids: string[]) { staged = ids.length ? ids : null; }
export function consumeStagedAttachments(): string[] | null { const s = staged; staged = null; return s; }

/** The send was accepted to the socket: the chips leave the composer (kept for a refusal). */
export function sendAccepted() {
  lastSent = chips;
  setChips([]);
}

/** Codes after which the chips go back to the composer (the text is restored by the chat code). */
const RESTORE_CODES = new Set(['attachment_invalid', 'maintenance', 'model_not_allowed', 'quota_exceeded', 'context_overflow']);
export function restoreFailedSend(code: string | undefined) {
  if (!code || !RESTORE_CODES.has(code) || !lastSent.length) return;
  const back = lastSent;
  lastSent = [];
  setChips([...back, ...chips]);
}

/** The i18n key of a chip's failure. */
export function chipErrorKey(c: Chip): string { return attachErrorKey(c.errorCode); }
