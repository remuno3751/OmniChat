// Phase-4 (v4) API: Code sessions/checkpoints, approval rules, notifications, templates, pets.
// Own fetch helper (uses the exported url + token of api.ts), same pattern as apiHistory.ts.
import { ApiError, getServerUrl, getToken, httpStatusText, serverErrorText, unreachableError } from './api';
import { t } from './i18n';
import type {
  ApprovalRule, CodeCheckpoint, CodeSession, FileChange, PetInfo, PetManifest, Settings, Template,
} from './protocol';

async function v4fetch(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

async function v4json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await v4fetch(method, path, body);
  const text = await res.text();
  try { return (text ? JSON.parse(text) : null) as T; } catch { throw new ApiError(t('api.invalidResponse'), res.status); }
}

const qs = (params: Record<string, string | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

/** In-memory cache of pet sheet URLs (object URLs on web, data URIs elsewhere). */
const petSheetCache = new Map<string, Promise<string>>();

function blobToUrl(blob: Blob): Promise<string> {
  const URLc: any = (globalThis as any).URL;
  if (URLc && typeof URLc.createObjectURL === 'function') return Promise.resolve(URLc.createObjectURL(blob));
  return new Promise<string>((resolve, reject) => {
    const FR: any = (globalThis as any).FileReader;
    if (!FR) { reject(new ApiError(t('api.petSheetFailed'), 0)); return; }
    const r = new FR();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ApiError(t('api.petSheetFailed'), 0));
    r.readAsDataURL(blob);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const FR: any = (globalThis as any).FileReader;
    if (!FR) { reject(new ApiError(t('api.invalidResponse'), 0)); return; }
    const r = new FR();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ApiError(t('api.invalidResponse'), 0));
    r.readAsDataURL(blob);
  });
}

export interface PreviewStatus { available: boolean; reason?: 'not_code' | 'no_bridge' | 'bridge_offline' | 'fs_disabled' }
export interface PreviewEntry { name: string; kind: 'file' | 'dir'; size: number }

export const apiV4 = {
  /** Code preview, stage 2: read-only files of the PC working folder through the bridge (docs/design/CODE-PREVIEW.md). */
  codePreviewStatus: async (conversationId: string): Promise<PreviewStatus> =>
    (await v4json<PreviewStatus>('GET', `/code/preview/status${qs({ conversationId })}`)) ?? { available: false },
  codePreviewTree: async (conversationId: string, path: string): Promise<PreviewEntry[]> =>
    (await v4json<{ entries?: PreviewEntry[] }>('GET', `/code/preview/tree${qs({ conversationId, path })}`))?.entries || [],
  /** Text content, or a data: URL when `asDataUrl` (images). */
  codePreviewFile: async (conversationId: string, path: string, asDataUrl: boolean): Promise<string> => {
    const res = await v4fetch('GET', `/code/preview/file${qs({ conversationId, path })}`);
    return asDataUrl ? blobToDataUrl(await res.blob()) : res.text();
  },

  /** GET /code/sessions -> code-mode conversations, newest first. */
  codeSessions: async (): Promise<CodeSession[]> =>
    (await v4json<{ sessions: CodeSession[] }>('GET', '/code/sessions'))?.sessions || [],

  /** GET /messages/:id/changes. The server answers {messageId, changes}; a bare array is accepted too. */
  messageChanges: async (messageId: string): Promise<FileChange[]> => {
    const r = await v4json<{ changes?: FileChange[] } | FileChange[] | null>('GET', `/messages/${encodeURIComponent(messageId)}/changes`);
    if (Array.isArray(r)) return r;
    return r?.changes || [];
  },

  /** GET /code/checkpoints?conversationId= */
  checkpoints: async (conversationId: string): Promise<CodeCheckpoint[]> =>
    (await v4json<{ checkpoints: CodeCheckpoint[] }>('GET', `/code/checkpoints${qs({ conversationId })}`))?.checkpoints || [],

  /** POST /code/checkpoints/:id/rewind. The caller must have the user's explicit confirmation. */
  rewind: (id: string, removeNew = false) =>
    v4json<{ ok: boolean }>('POST', `/code/checkpoints/${encodeURIComponent(id)}/rewind`, { removeNew }),

  /** GET /approval-rules?projectId= (no projectId = all rules). */
  approvalRules: async (projectId?: string): Promise<ApprovalRule[]> =>
    (await v4json<{ rules: ApprovalRule[] }>('GET', `/approval-rules${qs({ projectId })}`))?.rules || [],

  putApprovalRule: (id: string, b: {
    projectId?: string | null; kind: ApprovalRule['kind']; pattern: string; action: ApprovalRule['action']; note?: string | null;
  }) => v4json<ApprovalRule>('PUT', `/approval-rules/${encodeURIComponent(id)}`, b),

  deleteApprovalRule: (id: string) => v4json<{ ok: boolean }>('DELETE', `/approval-rules/${encodeURIComponent(id)}`),

  /** POST /notify/test (sends to the configured notifyUrl). */
  notifyTest: () => v4json<{ ok: boolean }>('POST', '/notify/test', {}),

  /** GET /templates?projectId= (no projectId = all). */
  templates: async (projectId?: string): Promise<Template[]> =>
    (await v4json<{ templates: Template[] }>('GET', `/templates${qs({ projectId })}`))?.templates || [],

  putTemplate: (id: string, b: {
    projectId?: string | null; name: string; body: string; description?: string; kind?: Template['kind'];
  }) => v4json<Template>('PUT', `/templates/${encodeURIComponent(id)}`, b),

  deleteTemplate: (id: string) => v4json<{ ok: boolean }>('DELETE', `/templates/${encodeURIComponent(id)}`),

  /** GET /pets (no blobs). */
  pets: async (): Promise<PetInfo[]> => (await v4json<{ pets: PetInfo[] }>('GET', '/pets'))?.pets || [],

  /** POST /pets: manifest + base64 sheet (PNG or WebP). */
  uploadPet: (b: { manifest: PetManifest; sheetBase64: string; mime: 'image/png' | 'image/webp' }) =>
    v4json<PetInfo>('POST', '/pets', b),

  deletePet: (id: string) => {
    const old = petSheetCache.get(id);
    if (old) {
      petSheetCache.delete(id);
      old.then((u) => { if (u.startsWith('blob:')) (globalThis as any).URL?.revokeObjectURL?.(u); }, () => {});
    }
    return v4json<{ ok: boolean }>('DELETE', `/pets/${encodeURIComponent(id)}`);
  },

  /**
   * Usable <img src> for a pet sprite sheet. GET /pets/:id/sheet needs the Bearer header, so the
   * binary is fetched here and turned into an object URL (web) or a data URI (native). Cached per id.
   */
  petSheetBlobUrl: (id: string): Promise<string> => {
    const hit = petSheetCache.get(id);
    if (hit) return hit;
    const p = (async () => {
      const res = await v4fetch('GET', `/pets/${encodeURIComponent(id)}/sheet`);
      return blobToUrl(await res.blob());
    })();
    petSheetCache.set(id, p);
    p.catch(() => { if (petSheetCache.get(id) === p) petSheetCache.delete(id); });
    return p;
  },

  /** PUT /settings with only the v4 notification/pet keys (api.putSettings does not type them). */
  putNotify: (patch: { notify?: Settings['notify']; notifyUrl?: string | null; activePetId?: string | null }) =>
    v4json<Settings>('PUT', '/settings', patch),
};
