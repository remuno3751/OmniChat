// Native (Android / iOS) import of Codex pets. Same rules as the web path in petImport.ts: the manifest
// checks, PET_MAX_BYTES, PNG or WebP, and 600 KB per still. Nothing is resized here. There is no canvas on
// native and expo-image-manipulator is not installed, so a still is uploaded only when its original file is
// already within the limit. Sprite sheets are never resized (the server checks 1536x1872 / 1536x2288).
// Top level imports no react-native and no i18n: the pure helpers run under node:test. The caller passes
// `tr` (useT()) for messages, and expo-document-picker is loaded lazily, only when a picker runs.
import type { PetManifest } from './protocol';
import { matchStillFiles, STILL_MAX_BYTES, stillBytesOk } from './petStills';
import type { StillState } from './petStills';
import type { StillUpload } from './petImport';

/** Same limit as petImport.ts (the server enforces it too). */
export const PET_MAX_BYTES = 8 * 1024 * 1024;

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A file chosen with expo-document-picker (the fields used here). */
export interface NativePetFile { name: string; uri: string; size?: number; mimeType?: string }

export interface PetFault { key: string; vars?: Record<string, string> }
export type PetResult<T> = { ok: true; value: T } | { ok: false; fault: PetFault };

const fault = (key: string, vars?: Record<string, string>): PetFault => ({ key, vars });
const baseName = (p: string) => String(p || '').split(/[\\/]/).pop() || '';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parses and checks pet.json (same rules as the web parseManifest). */
export function parsePetManifest(text: string): PetResult<PetManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, fault: fault('pets.errBadJson') };
  }
  if (!isRecord(raw)) return { ok: false, fault: fault('pets.errManifest') };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const spritesheetPath = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath.trim() : '';
  const version: 1 | 2 | null = raw.spriteVersionNumber === 1 ? 1 : raw.spriteVersionNumber === 2 ? 2 : null;
  if (!id || id.length > 100 || !displayName || !spritesheetPath || version === null) {
    return { ok: false, fault: fault('pets.errManifest') };
  }
  const manifest: PetManifest = { id, displayName, spriteVersionNumber: version, spritesheetPath };
  if (typeof raw.description === 'string') manifest.description = raw.description;
  return { ok: true, value: manifest };
}

/** PNG or WebP from the MIME type, falling back to the file name. null for anything else. */
export function sheetMimeOf(name: string, mimeType?: string): 'image/png' | 'image/webp' | null {
  const type = String(mimeType || '').toLowerCase();
  if (type === 'image/png' || type === 'image/webp') return type;
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  return null;
}

/** The pet.json among the picked files (by file name, case-insensitive). */
export function findPetJson(files: NativePetFile[]): NativePetFile | null {
  return files.find((f) => baseName(f.name).toLowerCase() === 'pet.json') ?? null;
}

/**
 * The spritesheet named by the manifest. If no file has that name, the only PNG/WebP picked is used
 * (the same fallback as the web path); with several images and no match, null.
 */
export function findSpriteSheet(files: NativePetFile[], sheetPath: string): NativePetFile | null {
  const wanted = baseName(sheetPath).toLowerCase();
  const exact = files.find((f) => baseName(f.name).toLowerCase() === wanted);
  if (exact) return exact;
  const images = files.filter((f) => /\.(png|webp)$/i.test(String(f.name || '')));
  return images.length === 1 ? images[0] : null;
}

/** Fault when the picked sheet is already over PET_MAX_BYTES (size as reported by the picker). */
export function spriteSizeFault(size?: number): PetFault | null {
  return typeof size === 'number' && size > PET_MAX_BYTES ? fault('pets.errTooBig') : null;
}

/** Fault when a still is over the 600 KB limit. Used before reading (picker size) and after (bytes). */
export function stillSizeFault(bytes: number): PetFault | null {
  return stillBytesOk(bytes) ? null : fault('pets.native.imageTooBig');
}

/** Standard base64 of a buffer, in chunks (no spread into one call). */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return (globalThis as any).btoa(parts.join(''));
}

/** UTF-8 decode without relying on TextDecoder (missing on some native runtimes). */
export function decodeUtf8(buf: ArrayBuffer): string {
  const TD: any = (globalThis as any).TextDecoder;
  if (TD) return new TD('utf-8').decode(buf);
  let s = '';
  for (const b of new Uint8Array(buf)) s += '%' + b.toString(16).padStart(2, '0');
  return decodeURIComponent(s);
}

// ---- picking and reading (native only; the picker module is required on first use) ----

async function pickDocuments(types: string[]): Promise<NativePetFile[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DP = require('expo-document-picker');
  // base64 and file are web-only in expo-document-picker, so the bytes are read from `uri` instead.
  const res = await DP.getDocumentAsync({ type: types, multiple: true, copyToCacheDirectory: true });
  if (res.canceled || !Array.isArray(res.assets)) return [];
  return res.assets.map((a: any) => ({ name: String(a.name || ''), uri: String(a.uri), size: a.size, mimeType: a.mimeType }));
}

/** Pet files: pet.json and the spritesheet (PNG or WebP). Resolves [] when cancelled. */
export function pickNativePetFiles(): Promise<NativePetFile[]> {
  return pickDocuments(['application/json', 'text/plain', 'application/octet-stream', 'image/png', 'image/webp']);
}

/** Still images: up to six PNG or WebP files. Resolves [] when cancelled. */
export function pickNativeStillFiles(): Promise<NativePetFile[]> {
  return pickDocuments(['image/png', 'image/webp']);
}

async function readBytes(f: NativePetFile, tr: Translate): Promise<ArrayBuffer> {
  try {
    const res = await fetch(f.uri);
    return await res.arrayBuffer();
  } catch {
    throw new Error(tr('pets.errRead', { name: f.name }));
  }
}

function fail(tr: Translate, f: PetFault): Error {
  return new Error(tr(f.key, f.vars));
}

/** Reads pet.json and the spritesheet and returns the upload body (same shape as buildPetUpload). */
export async function buildNativePetUpload(
  files: NativePetFile[],
  tr: Translate,
): Promise<{ manifest: PetManifest; sheetBase64: string; mime: 'image/png' | 'image/webp' }> {
  const petJson = findPetJson(files);
  if (!petJson) throw new Error(tr('pets.errNoJson'));
  const parsed = parsePetManifest(decodeUtf8(await readBytes(petJson, tr)));
  if (!parsed.ok) throw fail(tr, parsed.fault);
  const manifest = parsed.value;
  const sheet = findSpriteSheet(files, manifest.spritesheetPath);
  if (!sheet) throw new Error(tr('pets.errNoSheet', { name: baseName(manifest.spritesheetPath) }));
  const big = spriteSizeFault(sheet.size);
  if (big) throw fail(tr, big);
  const mime = sheetMimeOf(sheet.name, sheet.mimeType);
  if (!mime) throw new Error(tr('pets.errType'));
  const buf = await readBytes(sheet, tr);
  if (buf.byteLength > PET_MAX_BYTES) throw new Error(tr('pets.errTooBig'));
  return { manifest, sheetBase64: bytesToBase64(buf), mime };
}

/**
 * Matches the picked files to states by name and reads each one as is (no resizing on native).
 * Refuses a missing idle image and any image over 600 KB.
 */
export async function prepareNativeStills(
  files: NativePetFile[],
  tr: Translate,
): Promise<Partial<Record<StillState, StillUpload>>> {
  const m = matchStillFiles(files);
  const out: Partial<Record<StillState, StillUpload>> = {};
  for (const state of Object.keys(m.images) as StillState[]) {
    const f = m.images[state] as NativePetFile;
    if (typeof f.size === 'number' && f.size > STILL_MAX_BYTES) throw fail(tr, fault('pets.native.imageTooBig'));
    const mime = sheetMimeOf(f.name, f.mimeType);
    if (!mime) throw new Error(tr('pets.errType'));
    const buf = await readBytes(f, tr);
    const bad = stillSizeFault(buf.byteLength);
    if (bad) throw fail(tr, bad);
    out[state] = { mime, dataBase64: bytesToBase64(buf), bytes: buf.byteLength };
  }
  if (!out.idle) throw new Error(tr('pets.create.needIdle'));
  return out;
}
