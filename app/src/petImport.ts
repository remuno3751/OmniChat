// Web-only import of Codex pets: a pet.json + spritesheet pair, or a folder that contains them.
// Nothing is bundled. The user picks their own files; they are read in the browser and the caller
// uploads { manifest, sheetBase64, mime } through apiV4.uploadPet. Nothing else is sent.
import { Platform } from 'react-native';
import { t } from './i18n';
import type { PetManifest } from './protocol';
import {
  STILL_WEBP_QUALITY, matchStillFiles, stillBytesOk, stillExportSize, stillInputOk,
} from './petStills';
import type { StillState } from './petStills';

/** Largest spritesheet accepted (decoded bytes; the server enforces the same limit). */
export const PET_MAX_BYTES = 8 * 1024 * 1024;

const webOnly = () => {
  if (Platform.OS !== 'web') throw new Error(t('pets.errWebOnly'));
};

const basename = (p: string) => p.split(/[\\/]/).pop() || '';
const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
};
/** Path inside a folder pick (webkitRelativePath), or the plain name for a file pick. */
const relPath = (f: any): string => String(f.webkitRelativePath || f.name || '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Opens a hidden file input. Resolves [] when the user cancels. Must run inside a click handler. */
function openPicker(folder: boolean, accept = '.json,.png,.webp'): Promise<File[]> {
  webOnly();
  const doc: any = (globalThis as any).document;
  return new Promise<File[]>((resolve) => {
    const input: any = doc.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.accept = accept;
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish(Array.from(input.files || []));
    input.addEventListener('cancel', () => finish([]));
    doc.body.appendChild(input);
    input.click();
  });
}

/** Lets the user pick pet.json and/or the spritesheet (PNG or WebP). */
export async function pickPetFiles(): Promise<File[]> {
  return openPicker(false);
}

/** Lets the user pick a whole pet folder. */
export async function pickPetFolder(): Promise<File[]> {
  return openPicker(true);
}

function readBuffer(file: any): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const FR: any = (globalThis as any).FileReader;
    const r = new FR();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(new Error(t('pets.errRead', { name: file.name })));
    r.readAsArrayBuffer(file);
  });
}

/** Base64 without spreading the whole array into one call (chunked to stay under the argument limit). */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK) as unknown as number[];
    parts.push(String.fromCharCode.apply(null, sub));
  }
  return (globalThis as any).btoa(parts.join(''));
}

function parseManifest(text: string): PetManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(t('pets.errBadJson'));
  }
  if (!isRecord(raw)) throw new Error(t('pets.errManifest'));
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const spritesheetPath = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath.trim() : '';
  const version: 1 | 2 | null = raw.spriteVersionNumber === 1 ? 1 : raw.spriteVersionNumber === 2 ? 2 : null;
  if (!id || id.length > 100 || !displayName || !spritesheetPath || version === null) {
    throw new Error(t('pets.errManifest'));
  }
  const manifest: PetManifest = { id, displayName, spriteVersionNumber: version, spritesheetPath };
  if (typeof raw.description === 'string') manifest.description = raw.description;
  return manifest;
}

/** PNG or WebP from the MIME type, falling back to the extension. */
function sheetMime(file: any): 'image/png' | 'image/webp' {
  const type = String(file.type || '').toLowerCase();
  if (type === 'image/png' || type === 'image/webp') return type;
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  throw new Error(t('pets.errType'));
}

/**
 * Reads pet.json and its spritesheet from the picked files and returns the upload body.
 * In a folder pick, the shallowest pet.json wins and the sheet is looked up next to it first.
 */
export async function buildPetUpload(files: File[]): Promise<{ manifest: PetManifest; sheetBase64: string; mime: 'image/png' | 'image/webp' }> {
  webOnly();
  const list = files as unknown as any[];
  const petJson = list
    .filter((f) => basename(relPath(f)).toLowerCase() === 'pet.json')
    .sort((a, b) => relPath(a).split(/[\\/]/).length - relPath(b).split(/[\\/]/).length)[0];
  if (!petJson) throw new Error(t('pets.errNoJson'));

  const TD: any = (globalThis as any).TextDecoder;
  const manifest = parseManifest(new TD('utf-8').decode(await readBuffer(petJson)));

  const dir = dirname(relPath(petJson));
  const sameDir = (f: any) => dirname(relPath(f)) === dir;
  const wanted = basename(manifest.spritesheetPath).toLowerCase();
  const images = list.filter((f) => /\.(png|webp)$/i.test(String(f.name || '')));
  let sheet: any = list.find((f) => String(f.name).toLowerCase() === wanted && sameDir(f))
    || list.find((f) => String(f.name).toLowerCase() === wanted);
  if (!sheet) {
    const near = images.filter(sameDir);
    const pool = near.length ? near : images;
    if (pool.length === 1) sheet = pool[0];
  }
  if (!sheet) throw new Error(t('pets.errNoSheet', { name: basename(manifest.spritesheetPath) }));
  if (sheet.size > PET_MAX_BYTES) throw new Error(t('pets.errTooBig'));

  const mime = sheetMime(sheet);
  const sheetBase64 = toBase64(await readBuffer(sheet));
  return { manifest, sheetBase64, mime };
}

// ---- Stills pets: up to 6 images named after the states (idle.png, thinking.png, ...) ----

/** Lets the user pick the state images (PNG or WebP). Must run inside a click handler. */
export async function pickStillFiles(): Promise<File[]> {
  return openPicker(false, '.png,.webp');
}

/** One image ready for upload. */
export interface StillUpload { mime: 'image/png' | 'image/webp'; dataBase64: string; bytes: number }

/** Keeps the original bytes (no canvas available). The size and PNG/WebP checks still apply. */
async function rawStill(file: any): Promise<StillUpload> {
  const mime = sheetMime(file);
  const buf = await readBuffer(file);
  if (!stillBytesOk(buf.byteLength)) throw new Error(t('pets.create.tooBig', { name: file.name }));
  return { mime, dataBase64: toBase64(buf), bytes: buf.byteLength };
}

/**
 * Web: scales the longest side to at most 512 px and re-encodes as WebP (q 0.85) on a canvas.
 * Falls back to the original file when the canvas or decoding is not available.
 * Throws when the result is still over 600 KB or the input is smaller than 16 px.
 */
export async function optimizeStill(file: File): Promise<StillUpload> {
  webOnly();
  const g: any = globalThis as any;
  const doc: any = g.document;
  const URLc: any = g.URL;
  if (!doc?.createElement || !URLc?.createObjectURL || typeof g.Image !== 'function') return rawStill(file);
  const url: string = URLc.createObjectURL(file);
  try {
    const img: any = await new Promise((resolve, reject) => {
      const i = new g.Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(t('pets.errRead', { name: file.name })));
      i.src = url;
    });
    const iw = Number(img.naturalWidth) || 0;
    const ih = Number(img.naturalHeight) || 0;
    if (!stillInputOk(iw, ih)) throw new Error(t('pets.create.tooSmall', { name: file.name }));
    const size = stillExportSize(iw, ih);
    const canvas: any = doc.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return rawStill(file);
    ctx.drawImage(img, 0, 0, size.w, size.h);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', STILL_WEBP_QUALITY));
    if (!blob) return rawStill(file);
    if (!stillBytesOk(blob.size)) throw new Error(t('pets.create.tooBig', { name: file.name }));
    const buf = await readBuffer(blob as any);
    return {
      mime: blob.type === 'image/png' ? 'image/png' : 'image/webp',
      dataBase64: toBase64(buf),
      bytes: buf.byteLength,
    };
  } finally {
    URLc.revokeObjectURL?.(url);
  }
}

/**
 * Matches the picked files to states by name and optimizes each one. Callers check the selection with
 * stillSelectionProblem() first; this still refuses a missing idle image.
 */
export async function prepareStills(files: File[]): Promise<Partial<Record<StillState, StillUpload>>> {
  const m = matchStillFiles(files as unknown as { name: string }[]);
  const out: Partial<Record<StillState, StillUpload>> = {};
  for (const state of Object.keys(m.images) as StillState[]) {
    const f = m.images[state] as unknown as File;
    out[state] = await optimizeStill(f);
  }
  if (!out.idle) throw new Error(t('pets.create.needIdle'));
  return out;
}
