// Protocol v7 remote server administration API (Settings > Server). Own fetch helper (uses the exported url + token of api.ts).
import { useEffect, useState } from 'react';
import { ApiError, api, getIsAdmin, getServerUrl, getToken, httpStatusText, serverErrorText, unreachableError } from './api';
import { t } from './i18n';
import type { AdminQuotaUser, QuotaSettings, QuotaStatus, UserQuota } from './quota';

export type AdminRole = 'admin' | 'user';

export interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
  disabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  devices: number;
  tokens30d: number;
}

export interface AdminGeneral {
  serverName: string;
  serverDescription: string;
  allowRegistration: boolean;
  allowRegistrationSource: 'db' | 'env';
  /** PROTOCOL-v7: access of a user with no grant row on a shared provider. Absent on old servers. */
  defaultSharedAccess?: 'none' | 'all';
  /** PROTOCOL-v7: may ordinary users add their own providers. Absent on old servers. */
  allowOwnProviders?: boolean;
}

export interface AdminOverview {
  server: { name: string; description: string; version: string; installType: string; uptimeSec: number; supervised: boolean; platform: string; node: string };
  users: { total: number; admins: number; disabled: number };
  restartPending: boolean;
}

export interface AdminNetwork {
  host: string;
  port: number;
  exposure: 'loopback' | 'lan' | 'all';
  trustProxy: boolean;
  corsOrigins: string[];
  tlsHint: string;
  editable: false;
}

export interface AdminAuditEntry {
  id: number;
  at: number;
  actorId: string;
  actor: string;
  action: string;
  key: string;
  oldValue: string | null;
  newValue: string | null;
}

export type AdminLogLevel = 'all' | 'error' | 'warn' | 'info';

async function afetch(method: string, path: string, body?: string): Promise<Response> {
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

async function ajson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await afetch(method, path, body === undefined ? undefined : JSON.stringify(body));
  const text = await res.text();
  try { return (text ? JSON.parse(text) : null) as T; } catch { throw new ApiError(t('api.invalidResponse'), res.status); }
}

const enc = encodeURIComponent;

/** GET /quota: the signed-in user's own usage (any user). */
export const getQuotaStatus = () => ajson<QuotaStatus>('GET', '/quota');

export const adminApi = {
  overview: () => ajson<AdminOverview>('GET', '/admin/overview'),
  settings: () => ajson<{ general: AdminGeneral }>('GET', '/admin/settings'),
  /** PROTOCOL-v7 usage quotas (docs/PROTOCOL-v7-quotas.md). */
  quotas: () => ajson<{ quotas: QuotaSettings }>('GET', '/admin/quotas'),
  putQuotas: (p: Partial<QuotaSettings>) => ajson<{ quotas: QuotaSettings }>('PUT', '/admin/quotas', p),
  quotaUsers: () => ajson<{ quotas: QuotaSettings; users: AdminQuotaUser[] }>('GET', '/admin/quotas/users'),
  putUserQuota: (id: string, b: UserQuota) => ajson<{ userId: string; override: UserQuota | null }>('PUT', `/admin/quotas/users/${enc(id)}`, b),
  deleteUserQuota: (id: string) => ajson<{ ok: true; removed: boolean }>('DELETE', `/admin/quotas/users/${enc(id)}`),
  putSettings: (p: Partial<Pick<AdminGeneral, 'serverName' | 'serverDescription' | 'allowRegistration' | 'defaultSharedAccess' | 'allowOwnProviders'>>) =>
    ajson<{ general: AdminGeneral }>('PUT', '/admin/settings', p),
  users: () => ajson<{ users: AdminUser[]; you: string }>('GET', '/admin/users'),
  createUser: (b: { username: string; password: string; role?: AdminRole }) =>
    ajson<{ id: string; username: string; role: AdminRole }>('POST', '/admin/users', b),
  patchUser: (id: string, b: { role?: AdminRole; disabled?: boolean }) =>
    ajson<{ ok: true }>('PATCH', `/admin/users/${enc(id)}`, b),
  resetPassword: (id: string, password: string) =>
    ajson<{ ok: true; revokedDevices: number }>('POST', `/admin/users/${enc(id)}/password`, { password }),
  revokeUser: (id: string) =>
    ajson<{ ok: true; revokedDevices: number; revokedKeys: number }>('POST', `/admin/users/${enc(id)}/revoke`, {}),
  deleteUser: (id: string, confirm: string, hard: boolean) =>
    ajson<{ ok: true; mode: 'disabled' | 'deleted' }>('DELETE', `/admin/users/${enc(id)}`, { confirm, hard }),
  network: () => ajson<AdminNetwork>('GET', '/admin/network'),
  restart: () => ajson<{ ok: true; mode: 'supervised' | 'respawn' }>('POST', '/admin/restart', { confirm: true }),
  logs: (level: AdminLogLevel, lines: number) =>
    ajson<{ lines: string[] }>('GET', `/admin/logs?level=${enc(level)}&lines=${lines}`),
  audit: (limit = 50) => ajson<{ entries: AdminAuditEntry[] }>('GET', `/admin/audit?limit=${limit}`),
  /** Markdown text. */
  diagnostics: async (): Promise<string> => (await afetch('GET', '/admin/diagnostics')).text(),
};

// ---- capability probe: admin role (from login) AND /version.adminSettings === true ----
// Cached per (serverUrl, token). Only definitive answers are cached; a failed probe is retried on the next mount.
const probeCache = new Map<string, boolean>();
const probeInflight = new Map<string, Promise<boolean>>();

const probeKey = () => `${getServerUrl()}\n${getToken() ?? ''}`;

function probeCapability(key: string): Promise<boolean> {
  const cached = probeCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let p = probeInflight.get(key);
  if (!p) {
    p = api.version()
      .then((v) => {
        const ok = v?.adminSettings === true;
        probeCache.set(key, ok);
        return ok;
      }, () => false)
      .catch(() => false)
      .finally(() => { probeInflight.delete(key); });
    probeInflight.set(key, p);
  }
  return p;
}

/** True only for an admin account on a server that reports adminSettings. Never throws. */
export function useServerAdminAvailable(): boolean {
  const isAdmin = getIsAdmin() === true;
  const key = probeKey();
  const [ok, setOk] = useState<boolean>(() => isAdmin && probeCache.get(key) === true);

  useEffect(() => {
    let alive = true;
    if (!isAdmin) {
      setOk(false);
    } else {
      const cached = probeCache.get(key);
      if (cached !== undefined) {
        setOk(cached);
      } else {
        setOk(false);
        probeCapability(key).then((v) => { if (alive) setOk(v); }, () => { if (alive) setOk(false); });
      }
    }
    return () => { alive = false; };
  }, [isAdmin, key]);

  return isAdmin && ok;
}
