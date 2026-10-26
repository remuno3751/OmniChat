/**
 * Pure parsing of Aria's `GET /voices` and the pre-upload check for voice files (no React / native imports).
 *
 * Assumptions about the response (the shape is NOT verified against a real Aria; only "name, license, speakers and
 * style ids" are documented in docs/design/ARIA-VOICE-PHASE2.md). Everything is therefore read defensively:
 *  - the body is an array, or an object holding the array under `voices` / `models` / `items` / `data`;
 *  - a model has an id under `uuid` / `id` / `model_uuid` (needed only for delete), a name under `name` / `model_name`,
 *    a license under `license` (string, or an object with `name`/`text`) and speakers under `speakers` / `voices`;
 *  - a speaker has a `name` and `styles` (array, or {name: id} object); a style is an object with `id` / `style_id` /
 *    `voice` / `voice_id` and `name` / `style_name`, or a bare string/number id;
 *  - a model without any style yields no choosable style; a model without a license shows license = '' (the UI says
 *    "not stated"); unknown fields are ignored.
 * The style id that the user picks is stored as-is (string) in `voice.voice`.
 */

export interface VoiceStyle { id: string; name: string }
export interface VoiceSpeaker { name: string; styles: VoiceStyle[] }
export interface VoiceModel { uuid: string; name: string; license: string; speakers: VoiceSpeaker[] }

export const MAX_VOICE_BYTES = 300 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown, max = 2000): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
const first = (o: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

function parseStyle(v: unknown, fallbackName = ''): VoiceStyle | null {
  if (typeof v === 'string' || typeof v === 'number') { const id = s(v, 200); return id ? { id, name: fallbackName || id } : null; }
  if (!isObj(v)) return null;
  const id = s(first(v, ['id', 'style_id', 'voice', 'voice_id']), 200);
  if (!id) return null;
  return { id, name: s(first(v, ['name', 'style_name', 'label']), 200) || fallbackName || id };
}

function parseStyles(v: unknown): VoiceStyle[] {
  const out: VoiceStyle[] = [];
  if (Array.isArray(v)) for (const x of v) { const st = parseStyle(x); if (st) out.push(st); }
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { const st = parseStyle(x, k); if (st) out.push(st); }
  return out;
}

function parseLicense(v: unknown): string {
  if (typeof v === 'string') return v.trim().slice(0, 2000);
  if (isObj(v)) return s(first(v, ['name', 'text', 'title', 'summary']));
  return '';
}

function parseSpeakers(v: unknown): VoiceSpeaker[] {
  if (!Array.isArray(v)) return [];
  const out: VoiceSpeaker[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const styles = parseStyles(first(x, ['styles', 'style']));
    if (styles.length) out.push({ name: s(first(x, ['name', 'speaker_name']), 200), styles });
  }
  return out;
}

/** A model as the OmniChat server lists it: Aria's entry plus the owner (`ownerUserId`) and `mine` (the caller owns it). */
/** 'aivmx' = standard (balanced, .aivmx); 'piper' = fast (piper-plus, .onnx). */
export type VoiceFileKind = 'aivmx' | 'piper';
export type ServerVoiceModel = VoiceModel & { ownerUserId?: string; mine: boolean; kind?: VoiceFileKind; builtin?: boolean };

/** The list in a `GET /voices` body (or the server's `/voice/voices`); not a list = empty. */
function modelList(raw: unknown): unknown[] {
  const list = isObj(raw) ? first(raw, ['voices', 'models', 'items', 'data']) : raw;
  return Array.isArray(list) ? list : [];
}

/** One model entry; null when it has neither a name, an id nor speakers. */
function parseModel(x: Record<string, unknown>): VoiceModel | null {
  const speakers = parseSpeakers(first(x, ['speakers', 'voices']));
  const name = s(first(x, ['name', 'model_name', 'title']), 200);
  const uuid = s(first(x, ['uuid', 'id', 'model_uuid']), 200);
  if (!name && !uuid && !speakers.length) return null;
  return { uuid, name: name || uuid, license: parseLicense(x.license), speakers };
}

/** Voice models from a `GET /voices` body; anything unreadable is skipped (never throws). */
export function parseVoices(raw: unknown): VoiceModel[] {
  const out: VoiceModel[] = [];
  for (const x of modelList(raw)) {
    const m = isObj(x) ? parseModel(x) : null;
    if (m) out.push(m);
  }
  return out;
}

/** Voice models from the OmniChat server's `GET /voice/voices`: like parseVoices, plus `ownerUserId` and `mine`. */
export function parseServerVoices(raw: unknown): ServerVoiceModel[] {
  const out: ServerVoiceModel[] = [];
  for (const x of modelList(raw)) {
    if (!isObj(x)) continue;
    const m = parseModel(x);
    if (!m) continue;
    const ownerUserId = s(x.ownerUserId, 200);
    const kind: VoiceFileKind | undefined = x.kind === 'piper' || x.kind === 'aivmx' ? x.kind : undefined;
    out.push({
      ...m,
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(kind ? { kind } : {}),
      ...(x.builtin === true ? { builtin: true } : {}),
      mine: x.mine === true,
    });
  }
  return out;
}

/** Is `id` one of the styles listed (so the "current" mark can be shown)? */
export function isCurrentStyle(current: string, id: string): boolean {
  return !!current && current.trim() === id;
}

/** The part a picked file is in an upload: an .aivmx, or piper's model (.onnx), config (.json) or both in a .zip. */
export type VoiceFilePart = 'aivmx' | 'model' | 'config' | 'zip';
/** The accepted extensions per kind, and the part each one is. */
export const VOICE_PARTS: Record<VoiceFileKind, Record<string, VoiceFilePart>> = {
  aivmx: { '.aivmx': 'aivmx' },
  piper: { '.onnx': 'model', '.json': 'config', '.zip': 'zip' },
};

export type FileCheck = { ok: true; name: string; part: VoiceFilePart } | { ok: false; reason: 'ext' | 'size' | 'empty' | 'name' };

/**
 * The one place that checks a picked voice file before it is sent: the extension for `kind` (and which part it is),
 * 1 byte .. 300 MB. Returns the bare file name to send. Every upload path goes through this.
 */
export function checkVoiceFile(kind: VoiceFileKind, name: string, size: number): FileCheck {
  const n = (name || '').split(/[\\/]/).pop()!.trim();
  if (!n || n.length > 200) return { ok: false, reason: 'name' };
  const dot = n.lastIndexOf('.');
  const part = dot > 0 ? VOICE_PARTS[kind][n.slice(dot).toLowerCase()] : undefined;
  if (!part) return { ok: false, reason: 'ext' };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'empty' };
  if (size > MAX_VOICE_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, name: n, part };
}

/** A model's kind; a model without one is standard (aivmx). */
export const modelKind = (m: { kind?: VoiceFileKind }): VoiceFileKind => (m.kind === 'piper' ? 'piper' : 'aivmx');
/** Standard (balanced) uses aivmx voices; fast uses piper voices. */
export const kindForTtsMode = (mode: string | undefined): VoiceFileKind => (mode === 'fast' ? 'piper' : 'aivmx');
/** Built-in models (e.g. tsukuyomi) cannot be deleted. */
export const isBuiltinVoice = (m: { uuid: string; builtin?: boolean }): boolean => m.builtin === true || m.uuid === 'tsukuyomi';
/** The first style of a model ('' when it has none). */
export const firstStyleId = (m: Pick<VoiceModel, 'speakers'>): string => m.speakers[0]?.styles[0]?.id ?? '';
/** The voice id a model is chosen and previewed with: a piper voice is its id; an aivmx voice is its first style. */
export const modelVoiceId = (m: Pick<VoiceModel, 'uuid' | 'name' | 'speakers'>, kind: VoiceFileKind): string =>
  kind === 'piper' ? m.uuid || m.name : firstStyleId(m);

/** Whole minutes and seconds of a call-time total (non-numbers and negatives count as 0). */
export function callTimeParts(seconds: number): { min: number; sec: number } {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return { min: Math.floor(total / 60), sec: total % 60 };
}

/** Path for the upload (`name` is URL-encoded). */
export const uploadPath = (name: string): string => `/voices/models?name=${encodeURIComponent(name)}`;
/** Path for the delete (`uuid` is URL-encoded). */
export const deletePath = (uuid: string): string => `/voices/models/${encodeURIComponent(uuid)}`;

/** "12.3 MB" style size. */
export function fmtMB(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
