import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApiKeyCreated, ApiKeyInfo, AuthResponse, ContextOverflow, ContextUsage, Conversation, DebugInfo, Device, Effort, LocalServer, ModelsResponse, Project, PromptPreset, Provider, ProviderModelsResponse, SamplingParams, Settings, StatsResponse, SyncResponse, SystemMode } from './protocol';

import type { CompactResult, UsageChats, UsageDaily, UsageModels, UsageSummary } from './protocol';
import type { SearchBackendId, SearchConfig, SearchConfigPatch, SearchMode, SearchResult, SearchStatus, ToolInfo } from './protocol';
import { t } from './i18n';
import { webDeviceName } from './deviceName';
import type { DefaultSharedAccess, GrantRow, SharedProviderInfo } from './sharedProviders';
import type { SamplingParams as SP3 } from './protocol';

const K_URL = 'omnichat.serverUrl';
const K_AUTH = 'omnichat.auth';

export function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function defaultServerUrl(): string {
  if (Platform.OS === 'web') {
    const loc: any = (globalThis as any).location;
    const host = loc?.hostname || 'localhost';
    const proto = loc?.protocol === 'https:' ? 'https:' : 'http:';
    // Served by the OmniChat server itself (any port, or behind a reverse proxy): talk to the same origin.
    // Only the Expo dev servers (8081 / 19006) need the default server port.
    if (loc?.origin && /^https?:$/.test(loc.protocol) && loc.port !== '8081' && loc.port !== '19006') return loc.origin;
    return `${proto}//${host}:8787`;
  }
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
}

let serverUrl = defaultServerUrl();
let token: string | null = null;

export interface StoredAuth { userId: string; username: string; token: string; deviceId?: string; isAdmin?: boolean }

/** undefined = unknown (session stored by an older app version): admin-only controls stay visible and the server decides. */
let adminFlag: boolean | undefined;
export const getIsAdmin = () => adminFlag;

export async function loadConfig(): Promise<StoredAuth | null> {
  try {
    const u = await AsyncStorage.getItem(K_URL);
    if (u) serverUrl = u;
    const a = await AsyncStorage.getItem(K_AUTH);
    if (a) {
      const parsed = JSON.parse(a) as StoredAuth;
      token = parsed.token;
      adminFlag = parsed.isAdmin;
      return parsed;
    }
  } catch {}
  return null;
}
export const getServerUrl = () => serverUrl;
export const getToken = () => token;
export async function setServerUrl(u: string) {
  serverUrl = u.trim().replace(/\/+$/, '');
  await AsyncStorage.setItem(K_URL, serverUrl);
}
export async function saveAuth(a: StoredAuth | null) {
  token = a ? a.token : null;
  adminFlag = a ? a.isAdmin : undefined;
  if (a) await AsyncStorage.setItem(K_AUTH, JSON.stringify(a));
  else await AsyncStorage.removeItem(K_AUTH);
}

/** Called when an authed request answers 401 (token revoked / expired). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(f: (() => void) | null) { onUnauthorized = f; }

const inDesktopApp = (): boolean => !!(globalThis as any).window?.__OMNICHAT_DESKTOP__;

/** Default device name for login/register, e.g. 'Web (Chrome)', 'OmniChat Desktop (Windows)' or 'Android (Pixel 7)'. */
export function defaultDeviceName(): string {
  if (Platform.OS === "web") return webDeviceName((globalThis as any).navigator?.userAgent || "", inDesktopApp());
  const c: any = (Platform as any).constants;
  const detail = c?.Model || c?.model || "";
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return detail ? `${os} (${detail})` : os;
}
/** Sent as the device platform; the desktop app says 'desktop' rather than 'web'. */
export const devicePlatform = (): string => (Platform.OS === "web" && inDesktopApp() ? "desktop" : Platform.OS);

export class ApiError extends Error {
  status: number;
  /** the server's error code when it sent one (e.g. 'maintenance' with HTTP 503) */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Client-side error for a request that never got an answer (status 0). */
export const unreachableError = () => new ApiError(t('api.unreachable', { url: serverUrl }), 0);

/** Server error texts we know, keyed by the exact English string the server sends. */
const SERVER_ERROR_KEYS: Record<string, string> = {
  Unauthorized: 'api.err.401',
  Forbidden: 'api.err.403',
  'Not found': 'api.err.404',
  'Provider not found': 'api.err.providerNotFound',
};

/** Shows a known server error in the active language; any other server text is passed through. */
export function serverErrorText(raw: string): string {
  return Object.prototype.hasOwnProperty.call(SERVER_ERROR_KEYS, raw) ? t(SERVER_ERROR_KEYS[raw]) : raw;
}

/** Message for an HTTP status when the server sent no error text. */
export function httpStatusText(status: number): string {
  if (status === 400) return t('api.err.400');
  if (status === 401) return t('api.err.401');
  if (status === 403) return t('api.err.403');
  if (status === 404) return t('api.err.404');
  if (status >= 500) return t('api.err.5xx', { status });
  return t('api.err.http', { status });
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw unreachableError();
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/')) onUnauthorized?.();
    // the server sends { error: "text", code? } for app routes and the OpenAI shape { error: { type, code, message } } for /v1 and maintenance refusals
    const errObj = data?.error && typeof data.error === 'object' ? data.error : null;
    const code = typeof data?.code === 'string' ? data.code : typeof errObj?.code === 'string' ? errObj.code : undefined;
    const errText = errObj ? (typeof errObj.message === 'string' ? errObj.message : '') : data?.error ? String(data.error) : '';
    // a maintenance refusal carries the admin's message as its text: show it as is
    const text = errText ? (code === 'maintenance' ? errText : serverErrorText(errText)) : httpStatusText(res.status);
    throw new ApiError(text, res.status, code);
  }
  return data as T;
}

/** Query string from the defined entries only (undefined / null are skipped). */
function usageQuery(o: Record<string, string | number | undefined | null>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** A connected PC bridge as GET /bridges reports it. The workspace fields are absent on an older server / plugin. */
export interface BridgeInfo {
  name: string; cwd?: string; online: boolean; pluginVersion?: string;
  workspacesSupported?: boolean; workspaces?: string[]; allowAnyCwd?: boolean;
}

export const api = {
  register: (username: string, password: string, deviceName: string = defaultDeviceName()) =>
    req<AuthResponse>('POST', '/auth/register', { username, password, deviceName, platform: devicePlatform() }),
  login: (username: string, password: string, deviceName: string = defaultDeviceName()) =>
    req<AuthResponse>('POST', '/auth/login', { username, password, deviceName, platform: devicePlatform() }),
  logout: () => req<unknown>('POST', '/auth/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) => req<{ ok: true; revokedDevices: number }>('POST', '/auth/password', { currentPassword, newPassword }),
  ping: async (signal?: any) => {
    const r = await fetch(serverUrl + '/ping', { signal });
    if (!r.ok) throw new ApiError(httpStatusText(r.status), r.status);
    return r.json().catch(() => ({})) as Promise<{ t?: number }>;
  },
  contextUsage: (convId: string) => req<ContextUsage>('GET', `/conversations/${encodeURIComponent(convId)}/context`),
  contextDraft: (convId: string, b: { draft?: string; providerId?: string; model?: string; effort?: Effort }) =>
    req<ContextUsage>('POST', `/conversations/${encodeURIComponent(convId)}/context`, b),
  stats: (since?: number, recent = 20) =>
    req<StatsResponse>('GET', `/stats?recent=${recent}${since ? `&since=${since}` : ''}`),
  /** CSV text of all metrics rows (GET /stats/export). */
  statsExport: async (): Promise<string> => {
    let res: Response;
    try { res = await fetch(serverUrl + '/stats/export', { headers: token ? { Authorization: `Bearer ${token}` } : {} }); } catch { throw unreachableError(); }
    if (!res.ok) throw new ApiError(httpStatusText(res.status), res.status);
    return res.text();
  },
  tools: () => req<{ tools: ToolInfo[] }>('GET', '/tools'),
  reloadTools: () => req<{ tools?: ToolInfo[] }>('POST', '/tools/reload', {}),
  toolGrants: () => req<{ grants: { tool: string; grantedAt: number }[] }>('GET', '/tool-grants'),
  revokeToolGrant: (tool: string) => req<unknown>('DELETE', `/tool-grants/${encodeURIComponent(tool)}`),
  searchStatus: () => req<SearchStatus>('GET', '/search/status'),
  searchConfig: () => req<SearchConfig>('GET', '/search/config'),
  putSearchConfig: (b: SearchConfigPatch) => req<SearchConfig>('PUT', '/search/config', b),
  searchTest: (query: string, mode?: SearchBackendId) =>
    req<{ results?: SearchResult[]; error?: string; usedBackend?: string; tried?: string[]; status?: number }>(
      'POST', '/search/test', mode ? { query, mode } : { query }),
  version: () => req<{ name: string; version: string; webUi?: boolean; ephemeral?: boolean; adminSettings?: boolean; serverName?: string; serverDescription?: string }>('GET', '/version'),
  devices: () => req<{ devices: Device[] }>('GET', '/devices'),
  revokeDevice: (id: string) => req<unknown>('DELETE', `/devices/${encodeURIComponent(id)}`),
  apiKeys: () => req<{ keys: ApiKeyInfo[] }>('GET', '/apikeys'),
  createApiKey: (name: string) => req<ApiKeyCreated>('POST', '/apikeys', { name }),
  deleteApiKey: (id: string) => req<unknown>('DELETE', `/apikeys/${encodeURIComponent(id)}`),
  putProject: (id: string, b: Partial<Pick<Project, 'name' | 'systemPrompt' | 'systemMode' | 'defaultProviderId' | 'defaultModel' | 'effort' | 'params'>> & { tools?: string[] | null; searchMode?: SearchMode | null; mode?: 'chat' | 'code' }) =>
    req<Project>('PUT', `/projects/${id}`, b),
  deleteProject: (id: string) => req<Project>('DELETE', `/projects/${id}`),
  putPreset: (id: string, b: { name?: string; text?: string }) => req<PromptPreset>('PUT', `/presets/${id}`, b),
  deletePreset: (id: string) => req<PromptPreset>('DELETE', `/presets/${id}`),
  putSettings: (b: Partial<{ systemPrompt: string | null; effort: Effort | null; params: SamplingParams | null; devMode: boolean; contextOverflow: ContextOverflow; contextLimits: Record<string, number> | null; tools: string[] | null; searchMode: SearchMode; autoTitle: boolean; titleEvery: number; titleModel: string | null; modelParams: Record<string, SP3> | null; defaultContextLength: number | null; contextCompressAt: number | null; contextCompressTarget: number; ephemeralIdleMinutes: number }>) =>
    req<Settings>('PUT', '/settings', b),
  messageDebug: (id: string) => req<DebugInfo>('GET', `/messages/${encodeURIComponent(id)}/debug`),
  loadModel: (providerId: string, model: string, contextLength?: number) =>
    req<{ ok: boolean }>('POST', `/providers/${encodeURIComponent(providerId)}/models/load`, contextLength ? { model, contextLength } : { model }),
  unloadModel: (providerId: string, model: string) =>
    req<{ ok: boolean }>('POST', `/providers/${encodeURIComponent(providerId)}/models/unload`, { model }),
  sync: (since: number) => req<SyncResponse>('GET', `/sync?since=${since}`),
  putConversation: (id: string, b: {
    title?: string; providerId?: string | null; model?: string | null;
    projectId?: string | null; systemPrompt?: string | null; systemMode?: SystemMode; effort?: Effort | null;
    params?: SamplingParams | null; headId?: string | null; tools?: string[] | null; searchMode?: SearchMode | null;
    contextOverflow?: ContextOverflow | null;
    pinned?: boolean;
    mode?: 'chat' | 'code';
    /** v7: true creates an ephemeral chat (id must start with eph_) */
    ephemeral?: boolean;
  }) =>
    req<Conversation>('PUT', `/conversations/${id}`, b),
  deleteConversation: (id: string) => req<Conversation>('DELETE', `/conversations/${id}`),
  /** v7: destroys an ephemeral chat on the server (idempotent). */
  endEphemeral: (id: string) => req<unknown>('DELETE', `/conversations/${encodeURIComponent(id)}`).then(() => undefined),
  /** v7: destroys all live ephemeral chats of this user. */
  endAllEphemeral: () => req<{ destroyed: number }>('DELETE', '/ephemeral').then(() => undefined),
  putProvider: (id: string, b: { name: string; kind: string; baseUrl: string; model: string; apiKey?: string; effortProfile?: string | null }) =>
    req<Provider>('PUT', `/providers/${id}`, b),
  deleteProvider: (id: string) => req<Provider>('DELETE', `/providers/${id}`),
  models: (refresh = false) => req<ModelsResponse>('GET', refresh ? '/models?refresh=1' : '/models'),
  localServers: () => req<{ servers: LocalServer[] }>('GET', '/local-servers'),
  providerModels: (id: string) => req<ProviderModelsResponse>('GET', `/providers/${encodeURIComponent(id)}/models`),
  kinds: () => req<{ kinds: string[] }>('GET', '/provider-kinds'),
  /** PC bridges (DeepSeek Harness) known to the server, with online state. */
  bridges: () => req<{ bridges: BridgeInfo[] }>('GET', '/bridges'),
  /** Creates a device token for a dsh plugin (shown once). Always sends a JSON object body. */
  createBridgeToken: (name?: string) => req<{ token: string; deviceId: string; name: string }>('POST', '/bridges/token', { name: name ?? '' }),
  /** Token totals for a period (from: epoch ms, omitted = all time; tz = minutes east of UTC). */
  usageSummary: (p: { from?: number; to?: number; tz: number; conversationId?: string }) =>
    req<UsageSummary>('GET', `/usage/summary?${usageQuery({ from: p.from, to: p.to, tz: p.tz, conversationId: p.conversationId })}`),
  /** Exactly `days` zero-filled daily buckets ending today; 0 = all days. */
  usageDaily: (days: number, tz: number) => req<UsageDaily>('GET', `/usage/daily?${usageQuery({ days, tz })}`),
  usageChats: (p: { from?: number; to?: number; limit?: number }) =>
    req<UsageChats>('GET', `/usage/chats?${usageQuery({ from: p.from, to: p.to, limit: p.limit })}`),
  usageModels: (p: { from?: number; to?: number }) =>
    req<UsageModels>('GET', `/usage/models?${usageQuery({ from: p.from, to: p.to })}`),
  /** Summarizes the older part of a chat (409 while generating, 502 summarization failed, 410 ephemeral gone). */
  compact: (convId: string, body: { instructions?: string; keepTurns?: number } = {}) =>
    req<CompactResult>('POST', `/conversations/${encodeURIComponent(convId)}/compact`, body),
  // Server update system (admin mutations; the server answers 403 for non-admins)
  updateStatus: () => req<import('./updateTypes').UpdateStatus>('GET', '/update/status'),
  updateCheck: (channel?: import('./updateTypes').Channel) =>
    req<import('./updateTypes').UpdateStatus>('POST', '/update/check', channel ? { channel } : {}),
  updateApply: (version?: string) =>
    req<{ ok: boolean; phase?: string }>('POST', '/update/apply', version ? { version } : {}),
  updateSkip: (version: string) => req<unknown>('POST', '/update/skip', { version }),
  updateUnskip: (version: string) => req<unknown>('POST', '/update/unskip', { version }),
  updateConfig: (b: { channel?: import('./updateTypes').Channel; checkHours?: number; githubToken?: string | null }) =>
    req<import('./updateTypes').UpdateStatus>('PUT', '/update/config', b),
  updateAck: () => req<unknown>('POST', '/update/ack', {}),
  /** Maintenance mode state. No login needed; old servers answer 404. */
  getMaintenance: () => req<{ maintenance: import('./protocol').Maintenance }>('GET', '/maintenance'),
  /** Admin only, partial update. eta: epoch ms, null = clear, omitted = keep. */
  putMaintenance: (p: { enabled?: boolean; message?: string; eta?: number | null }) =>
    req<{ maintenance: import('./protocol').Maintenance }>('PUT', '/admin/maintenance', p),
  /** PROTOCOL-v7 shared providers (admin only). Keys and URLs are never returned. */
  setProviderShared: (id: string, shared: boolean) =>
    req<{ id: string; shared: boolean }>('PUT', `/admin/providers/${encodeURIComponent(id)}/shared`, { shared }),
  sharedProviders: () => req<{ providers: SharedProviderInfo[] }>('GET', '/admin/shared-providers'),
  userGrants: (userId: string) =>
    req<{ defaultSharedAccess: DefaultSharedAccess; grants: GrantRow[] }>('GET', `/admin/users/${encodeURIComponent(userId)}/grants`),
  putUserGrant: (userId: string, providerId: string, b: { mode: 'all' | 'list' | 'none'; models?: string[] }) =>
    req<{ providerId: string; mode: string; models: string[] }>('PUT', `/admin/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(providerId)}`, b),
  deleteUserGrant: (userId: string, providerId: string) =>
    req<{ ok: boolean; removed: boolean }>('DELETE', `/admin/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(providerId)}`),
  wsUrl: () => serverUrl.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token || ''),
};

// ---- PROTOCOL-v7 attachments (docs/PROTOCOL-v7-attachments.md) ----

export interface AttachmentMeta { id: string; name: string; mime: string; kind: 'image' | 'document' | 'audio' | 'other'; size: number; status: 'ready' | 'deleted'; textChars?: number }
export interface AttachmentSettings { maxFileMB: number; quotaMB: number; retentionDays: number; maxPerMessage: number; extractMaxChars: number; transcribeModel: string | null }

/** Upload the bytes as they are (XHR, so the progress can be shown). `body` is a Blob on both web and native. */
export function uploadAttachment(body: Blob, name: string, mime: string, onProgress?: (frac: number) => void): Promise<{ attachment: AttachmentMeta; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', serverUrl + '/attachments');
    xhr.setRequestHeader('Content-Type', mime || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (onProgress) xhr.upload.onprogress = (e: any) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(unreachableError());
    xhr.onload = () => {
      let data: any = null;
      try { data = JSON.parse(xhr.responseText || 'null'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.attachment) {
        resolve({ attachment: data.attachment, warnings: Array.isArray(data.warnings) ? data.warnings : [] });
        return;
      }
      if (xhr.status === 401 && token) onUnauthorized?.();
      const code = typeof data?.code === 'string' ? data.code : undefined;
      reject(new ApiError(typeof data?.error === 'string' ? serverErrorText(data.error) : httpStatusText(xhr.status), xhr.status, code));
    };
    xhr.send(body);
  });
}

/** The raw bytes of one of the user's attachments (auth header needed, so no plain <img src>). */
async function fetchAttachmentBlob(id: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(serverUrl + `/attachments/${encodeURIComponent(id)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw unreachableError();
  }
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(httpStatusText(res.status), res.status);
  }
  return res.blob();
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/**
 * A URL for showing or saving an attachment. Web: an object URL (call `revoke` when done).
 * Native: a data URI (no file system module needed; revoke is a no-op).
 */
export async function attachmentBlobUrl(id: string): Promise<{ url: string; revoke: () => void; size: number }> {
  const blob = await fetchAttachmentBlob(id);
  if (Platform.OS === 'web' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url), size: blob.size };
  }
  return { url: await blobToDataUri(blob), revoke: () => {}, size: blob.size };
}

export const deleteAttachment = (id: string) => req<{ ok: boolean }>('DELETE', `/attachments/${encodeURIComponent(id)}`);
export const listAttachments = (conversationId?: string) =>
  req<{ attachments: (AttachmentMeta & { conversationId?: string | null; messageId?: string | null; createdAt?: number })[]; usage: { bytes: number; count: number } }>(
    'GET', `/attachments${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`);
/** Admin settings; the server wraps them as { attachments: {...} }. */
export async function getAdminAttachments(): Promise<AttachmentSettings> {
  const r: any = await req<any>('GET', '/admin/attachments');
  return (r?.attachments ?? r) as AttachmentSettings;
}
export const putAdminAttachments = (patch: Partial<AttachmentSettings>) => req<any>('PUT', '/admin/attachments', patch);
/** Per-model image support override (null clears them all). */
export const putModelVision = (map: Record<string, boolean> | null) => req<any>('PUT', '/settings', { modelVision: map });

/** Slide preview of a docx / pptx artifact: the server's slides, with each ```shapes block's checked spec filled in. Older servers answer 404 (ApiError.status). */
export function convertPreview(markdown: string, type: 'docx' | 'pptx', title: string): Promise<{ slides: { title: string; blocks: import('./docModel').Block[] }[] }> {
  return req<{ slides: { title: string; blocks: import('./docModel').Block[] }[] }>('POST', '/artifacts/convert/preview', { markdown, type, title });
}
