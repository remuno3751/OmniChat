// Code preview, stage 2: loads the real files of the PC working folder (read-only, through the server and the bridge).
import type { PreviewEntry, PreviewStatus } from './apiV4';
import { normalizePath } from './codePreview';
import type { VirtualFs } from './codePreview';

export interface PcApi {
  status(convId: string): Promise<PreviewStatus>;
  tree(convId: string, path: string): Promise<PreviewEntry[]>;
  file(convId: string, path: string, asDataUrl: boolean): Promise<string>;
}

const TEXT_RE = /\.(html?|css|m?js|svg|json|txt)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|ico)$/i;
const MAX_FILES = 80;
const MAX_DIRS = 40;
const MAX_DEPTH = 4;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;

export type PcResult =
  | { ok: true; fs: VirtualFs }
  | { ok: false; reason: NonNullable<PreviewStatus['reason']> | 'error' };

/** Walks the folder breadth-first (bounded) and fetches the preview-relevant files. Any failure falls back to the change records. */
export async function loadPcFs(convId: string, api: PcApi): Promise<PcResult> {
  let st: PreviewStatus;
  try { st = await api.status(convId); } catch { return { ok: false, reason: 'error' }; }
  if (!st.available) return { ok: false, reason: st.reason ?? 'error' };
  const fs: VirtualFs = new Map();
  try {
    const found: { path: string; size: number }[] = [];
    let queue = [''];
    let dirs = 0;
    for (let depth = 0; depth <= MAX_DEPTH && queue.length && found.length < MAX_FILES; depth++) {
      const next: string[] = [];
      for (const dir of queue) {
        if (dirs++ >= MAX_DIRS || found.length >= MAX_FILES) break;
        const entries = await api.tree(convId, dir);
        for (const e of entries) {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.kind === 'dir') next.push(p);
          else if (TEXT_RE.test(e.name) || (IMAGE_RE.test(e.name) && e.size <= MAX_IMAGE_BYTES)) found.push({ path: p, size: e.size });
        }
      }
      queue = next;
    }
    let total = 0;
    for (const f of found.slice(0, MAX_FILES)) {
      if (total + f.size > MAX_TOTAL_BYTES) continue;
      const p = normalizePath(f.path);
      if (!p) continue;
      const image = IMAGE_RE.test(f.path);
      const body = await api.file(convId, f.path, image);
      total += f.size;
      fs.set(p, image ? { content: '', stale: false, dataUrl: body } : { content: body, stale: false });
    }
  } catch {
    return { ok: false, reason: 'error' };
  }
  return { ok: true, fs };
}
