// Web-only import of Codex pets: a pet.json + spritesheet pair, or a folder that contains them.
// Nothing is bundled. The user picks their own files; they are read in the browser and the caller
// uploads { manifest, sheetBase64, mime } through apiV4.uploadPet. Nothing else is sent.
import { Platform } from 'react-native';
import { t } from './i18n';
import type { PetManifest } from './protocol';

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
function openPicker(folder: boolean): Promise<File[]> {
  webOnly();
  const doc: any = (globalThis as any).document;
  return new Promise<File[]>((resolve) => {
    const input: any = doc.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.accept = '.json,.png,.webp';
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
function toBase64(buf: ArrayBuffer): string {
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
