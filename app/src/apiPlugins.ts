// Protocol v7 plugin admin API (docs/PROTOCOL-v7-plugins.md): inspect, install, list, enable, remove, check-update.
// Own fetch helper (uses the exported url + token of api.ts), same pattern as apiV4.ts.
// Server errors are `{ error, code }`: the message is kept in ApiError.message and the code in ApiError.code.
import { ApiError, getServerUrl, getToken, httpStatusText, serverErrorText, unreachableError } from './api';
import { t } from './i18n';

export type PluginSeverity = 'high' | 'medium' | 'info';

export interface PluginFinding {
  rule: string;
  severity: PluginSeverity;
  file: string;
  line: number;
  snippet: string;
}

export interface PermissionMismatch {
  tool: string;
  used: string[];
  declared: string[];
}

export interface PluginScan {
  findings: PluginFinding[];
  permissionMismatch: PermissionMismatch[];
}

export interface PluginManifestTool {
  name: string;
  description: string;
  permissions: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  main: string;
  tools: PluginManifestTool[];
}

export interface PluginSource {
  repo: string;
  ref?: string | null;
  subdir?: string;
  commitSha: string;
}

export interface PluginFile {
  path: string;
  size: number;
  sha256: string;
}

export interface InspectBody {
  source: 'github';
  repo: string;
  ref?: string;
  subdir?: string;
}

/** Result of POST /admin/plugins/inspect. */
export interface InspectResult {
  inspectionId: string;
  source: PluginSource;
  manifest: PluginManifest;
  alreadyInstalled: boolean;
  installedCommitSha?: string;
  files: PluginFile[];
  totalBytes: number;
  scan: PluginScan;
  warnings: string[];
}

export interface PluginDiff {
  added: string[];
  removed: string[];
  changed: string[];
  toolsAdded: string[];
  toolsRemoved: string[];
  permissionsAdded: { tool: string; permission: string }[];
}

/** Result of POST /admin/plugins/:id/check-update. The inspection fields are present only when updateAvailable. */
export type CheckUpdateResult = {
  updateAvailable: boolean;
  latestCommitSha: string;
  diff?: PluginDiff;
  inspectionId?: string;
} & Partial<Omit<InspectResult, 'inspectionId'>>;

export interface PluginToolRow {
  name: string;
  permissions: string[];
  available: boolean;
  error?: string;
}

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'github' | 'local';
  repo?: string;
  ref?: string;
  commitSha?: string;
  enabled: boolean;
  installedAt?: number;
  updatedAt?: number;
  tools: PluginToolRow[];
  scan?: { high: number; medium: number; info: number };
  modified?: boolean;
}

async function pfetch(method: string, path: string, body?: unknown): Promise<any> {
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
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
  if (!res.ok) {
    const msg = typeof json?.error === 'string' && json.error ? serverErrorText(json.error) : httpStatusText(res.status);
    throw new ApiError(msg, res.status, typeof json?.code === 'string' ? json.code : undefined);
  }
  if (json === undefined) throw new ApiError(t('api.invalidResponse'), res.status);
  return json;
}

const enc = (id: string) => encodeURIComponent(id);

export const pluginsApi = {
  /** Fetches the repo from GitHub and inspects it in memory. Nothing is installed. */
  inspect: (body: InspectBody): Promise<InspectResult> => pfetch('POST', '/admin/plugins/inspect', body),
  /** Installs a previous inspection. `confirmId` must equal the manifest id exactly. */
  install: (inspectionId: string, confirmId: string): Promise<{ plugin: PluginRow }> =>
    pfetch('POST', '/admin/plugins/install', { inspectionId, confirmId }),
  list: async (): Promise<PluginRow[]> => (await pfetch('GET', '/admin/plugins'))?.plugins ?? [],
  setEnabled: (id: string, enabled: boolean): Promise<{ plugin: PluginRow }> =>
    pfetch('PATCH', `/admin/plugins/${enc(id)}`, { enabled }),
  remove: (id: string): Promise<{ ok: boolean }> => pfetch('DELETE', `/admin/plugins/${enc(id)}`),
  checkUpdate: (id: string): Promise<CheckUpdateResult> => pfetch('POST', `/admin/plugins/${enc(id)}/check-update`),
};
