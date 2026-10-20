import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import type { SearchMode, SearchStatus, ToolInfo, ToolPermission } from './protocol';
import { wsSend } from './socket';
import { toast } from './ui/toast';
import { t } from './i18n';

/** Read-only map over translated labels: `MAP[k]` is t(prefix + k), or undefined for an unknown k. */
function labelMap<K extends string>(prefix: string, known: readonly K[]): Record<K, string> {
  return new Proxy({} as Record<K, string>, {
    get: (_, k) => (typeof k === 'string' && (known as readonly string[]).includes(k) ? t(prefix + k) : undefined),
  });
}

/* ---------- pending tool approvals (WS tool_approval) ---------- */
export const APPROVAL_TIMEOUT_MS = 120000;
export interface Approval {
  approvalId: string; messageId: string; conversationId: string; tool: string; arguments: any;
  permissions: ToolPermission[]; receivedAt: number;
}
let approvals: Approval[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; };

export function addApproval(a: Omit<Approval, 'receivedAt'>) {
  if (approvals.some((x) => x.approvalId === a.approvalId)) return;
  approvals = [...approvals, { ...a, permissions: a.permissions || [], receivedAt: Date.now() }];
  emit();
}
export function removeApproval(approvalId: string) {
  if (!approvals.some((x) => x.approvalId === approvalId)) return;
  approvals = approvals.filter((x) => x.approvalId !== approvalId);
  emit();
}
/** The call moved on (running/done/denied...) or the generation ended: its prompt no longer applies. */
export function dropApprovalsFor(messageId: string, tool?: string) {
  const next = approvals.filter((x) => !(x.messageId === messageId && (!tool || x.tool === tool)));
  if (next.length !== approvals.length) { approvals = next; emit(); }
}
export function clearApprovals() { if (approvals.length) { approvals = []; emit(); } }
export const useApprovals = () => useSyncExternalStore(subscribe, () => approvals);

export function answerApproval(a: Approval, decision: 'once' | 'always' | 'deny'): boolean {
  if (!wsSend({ type: 'tool_approval_reply', approvalId: a.approvalId, decision })) {
    toast(t('approval.notConnected'), 'error');
    return false;
  }
  removeApproval(a.approvalId);
  return true;
}

/* ---------- permission wording ---------- */
const PERMS = ['network', 'filesystem-read', 'filesystem-write', 'shell'] as const;
/** Translated at access time (PERM_LABEL[p] is undefined for an unknown permission). */
export const PERM_LABEL: Record<string, string> = labelMap('tool.perm.', PERMS);
export const PERM_WARN: Record<string, string> = labelMap('tool.permWarn.', PERMS);
export const permDanger = (p: string) => p === 'shell' || p === 'filesystem-write';

/* ---------- shared caches: tools list, search status (undefined = loading, null = unsupported/old server) ---------- */
interface Cached<T> { value: T | undefined | null; error: string; loading: boolean }
function makeCache<T>(load: () => Promise<T>) {
  const c: Cached<T> = { value: undefined, error: '', loading: false };
  const l = new Set<() => void>();
  let snap = { ...c };
  const notify = () => { snap = { ...c }; l.forEach((f) => f()); };
  const refresh = async () => {
    if (c.loading) return;
    c.loading = true; c.error = ''; notify();
    try { c.value = await load(); } catch (e: any) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) c.value = null;
      else if (c.value === undefined) { c.value = null; c.error = e?.message || String(e); } else c.error = e?.message || String(e);
    }
    c.loading = false; notify();
  };
  const reset = () => { c.value = undefined; c.error = ''; c.loading = false; notify(); };
  const use = () => {
    const s = useSyncExternalStore((f) => { l.add(f); return () => { l.delete(f); }; }, () => snap);
    useEffect(() => { if (c.value === undefined && !c.loading) refresh(); }, [s.value]);
    return { value: s.value, loading: s.loading, error: s.error, refresh };
  };
  return { use, refresh, reset };
}

const toolsCache = makeCache<ToolInfo[]>(async () => (await api.tools()).tools || []);
/** value: ToolInfo[] | null (null = server has no tools endpoint) | undefined (loading) */
export const useTools = toolsCache.use;
const searchCache = makeCache<SearchStatus>(() => api.searchStatus());
export const useSearchStatus = searchCache.use;
export function resetToolCaches() { toolsCache.reset(); searchCache.reset(); }

/* ---------- search mode helpers ---------- */
const SEARCH_MODES = ['off', 'smart', 'auto', 'always'] as const;
/** Translated at access time. */
export const SEARCH_LABEL: Record<SearchMode, string> = labelMap('composer.search.', SEARCH_MODES);
const SEARCH_HELP_KEYS: Record<SearchMode, string> = {
  off: 'tool.search.helpOff', smart: 'tool.search.helpSmart', auto: 'composer.search.helpAuto', always: 'composer.search.helpAlways',
};
export const SEARCH_HELP: Record<SearchMode, string> = new Proxy({} as Record<SearchMode, string>, {
  get: (_, k) => (typeof k === 'string' && k in SEARCH_HELP_KEYS ? t(SEARCH_HELP_KEYS[k as SearchMode]) : undefined),
});
export function resolveSearch(chat: SearchMode | null | undefined, project: SearchMode | null | undefined, global: SearchMode | undefined): { mode: SearchMode; from: 'chat' | 'project' | 'global' | 'default' } {
  if (chat) return { mode: chat, from: 'chat' };
  if (project) return { mode: project, from: 'project' };
  if (global) return { mode: global, from: 'global' };
  return { mode: 'smart', from: 'default' };
}
export function resolveTools(chat: string[] | null | undefined, project: string[] | null | undefined, global: string[] | null | undefined): { tools: string[]; from: 'chat' | 'project' | 'global' | 'default' } {
  if (chat) return { tools: chat, from: 'chat' };
  if (project) return { tools: project, from: 'project' };
  if (global) return { tools: global, from: 'global' };
  return { tools: [], from: 'default' };
}
