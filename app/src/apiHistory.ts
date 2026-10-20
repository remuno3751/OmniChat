// Phase-3 History / Backup / Export / Import API. Own fetch helper (uses the exported url + token of api.ts).
import { Platform, Share } from 'react-native';
import { ApiError, getServerUrl, getToken, httpStatusText, serverErrorText, unreachableError } from './api';
import { t } from './i18n';
import type { BackupInfo, ExportBranches, ExportFormat, HistorySearchResponse, ImportCounts } from './historyTypes';

async function hfetch(method: string, path: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, { method, headers, body });
  } catch {
    throw unreachableError();
  }
  if (!res.ok) {
    let msg = httpStatusText(res.status);
    try { const j = JSON.parse(await res.text()); if (j?.error) msg = serverErrorText(String(j.error)); } catch {}
    throw new ApiError(msg, res.status);
  }
  return res;
}
async function hjson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await hfetch(method, path, body === undefined ? undefined : JSON.stringify(body));
  const text = await res.text();
  try { return (text ? JSON.parse(text) : null) as T; } catch { throw new ApiError(t('api.invalidResponse'), res.status); }
}

export const apiHistory = {
  search: (q: string, projectId: string | null, offset: number, limit = 20) =>
    hjson<HistorySearchResponse>('GET', `/history/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),
  backups: async () => (await hjson<{ backups: BackupInfo[] }>('GET', '/admin/backups'))?.backups || [],
  createBackup: () => hjson<BackupInfo>('POST', '/admin/backup', {}),
  deleteBackup: (name: string) => hjson<unknown>('DELETE', `/admin/backups/${encodeURIComponent(name)}`),
  /** Authenticated download of a backup as a Blob (web). */
  backupBlob: async (name: string): Promise<Blob> => (await hfetch('GET', `/admin/backups/${encodeURIComponent(name)}`)).blob(),
  exportConversation: async (id: string, format: ExportFormat, branches: ExportBranches, reasoning: boolean): Promise<string> => {
    const q = `format=${format}&branches=${branches}${reasoning ? '&reasoning=1' : ''}`;
    return (await hfetch('GET', `/conversations/${encodeURIComponent(id)}/export?${q}`)).text();
  },
  exportAll: async (): Promise<string> => (await hfetch('GET', '/export')).text(),
  /** body = the raw JSON text of an export file */
  importData: async (json: string): Promise<ImportCounts> => {
    const res = await hfetch('POST', '/import', json);
    const text = await res.text();
    try { return (text ? JSON.parse(text) : {}) as ImportCounts; } catch { return {}; }
  },
};

// ---- availability probes (old server => 404 => entries hidden) ----
type Avail = 'unknown' | 'yes' | 'no';
const avail: { history: Avail; admin: Avail } = { history: 'unknown', admin: 'unknown' };
let availVersion = 0;
const subs = new Set<() => void>();
const emit = () => { availVersion++; subs.forEach((f) => f()); };
export const subscribeAvail = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const getAvailVersion = () => availVersion;
export const getAvail = () => avail;
export function setAvail(k: 'history' | 'admin', v: Avail) { if (avail[k] !== v) { avail[k] = v; emit(); } }
export function resetAvail() { avail.history = 'unknown'; avail.admin = 'unknown'; emit(); }

/** Probes GET /history/search once per session: 404 (old server) hides the search entries. */
export async function probeHistory(): Promise<void> {
  if (avail.history !== 'unknown') return;
  try { await apiHistory.search('a', null, 0, 1); setAvail('history', 'yes'); }
  catch (e: any) {
    if (e instanceof ApiError && e.status === 404) setAvail('history', 'no');
    else if (e instanceof ApiError && e.status !== 0 && e.status !== 401) setAvail('history', 'yes');
  }
}
/** Probes GET /admin/backups: 200 => admin; 401/403/404 => hidden. */
export async function probeAdmin(): Promise<void> {
  if (avail.admin !== 'unknown') return;
  try { await apiHistory.backups(); setAvail('admin', 'yes'); }
  catch (e: any) { if (e instanceof ApiError && e.status !== 0) setAvail('admin', 'no'); }
}

// ---- delivering files ----
export function deliverBlobWeb(filename: string, blob: Blob) {
  const doc: any = (globalThis as any).document;
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}
/** Web: download through an anchor. Native: the system share sheet (text content). */
export async function deliverText(filename: string, text: string, mime: string): Promise<void> {
  if (Platform.OS === 'web') { deliverBlobWeb(filename, new Blob([text], { type: mime + ';charset=utf-8' })); return; }
  await Share.share({ title: filename, message: text });
}
