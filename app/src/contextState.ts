import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';
import type { ContextUsage, Effort, Settings } from './protocol';
import { rememberLimit } from './contextLimitMemory';

/* ---------- context_overflow notice (WS error frame with code 'context_overflow') ---------- */
let notice: string | null = null;
const subs = new Set<() => void>();
export function setOverflowNotice(m: string | null) { notice = m; subs.forEach((f) => f()); }
export function useOverflowNotice(): string | null {
  return useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => notice);
}

/* ---------- rough local token estimate (used for a chat that does not exist yet) ---------- */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯ｦ-ﾟ]/;
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 1 / 1.5 : 0.25;
  return Math.ceil(n);
}
const MSG_OVERHEAD = 4;

export const limitKey = (providerId: string, model: string) => `${providerId}::${model}`;

export interface LocalCtxIn {
  settings: Settings | null;
  projectPrompt?: string | null;
  providerId?: string | null;
  model?: string | null;
  /** context window reported by the backend adapter, if known */
  backendLimit?: number | null;
  draft: string;
}
export function localUsage(i: LocalCtxIn): ContextUsage {
  const sys = [i.settings?.systemPrompt, i.projectPrompt].filter((x) => x && x.trim()).join('\n\n');
  const system = sys ? estimateTokens(sys) + MSG_OVERHEAD : 0;
  const input = i.draft.trim() ? estimateTokens(i.draft) + MSG_OVERHEAD : 0;
  const override = i.providerId && i.model ? i.settings?.contextLimits?.[limitKey(i.providerId, i.model)] : undefined;
  const limit = override ?? i.backendLimit ?? null;
  const total = system + input;
  const reserve = 1024;
  return {
    limit, limitSource: override ? 'override' : i.backendLimit ? 'backend' : 'unknown', total,
    used: { system, history: 0, attachments: 0, tools: 0, input }, reasoning: 0, lastReasoning: 0,
    estimated: true, reserve, fits: limit == null || total + reserve <= limit, headId: null,
  };
}

/** The server answered 404/501 once: it has no context endpoint, hide the bar. */
let unsupported = false;

export interface CtxArgs {
  v3: boolean;
  convId: string;
  convExists: boolean;
  providerId: string | null;
  model: string | null;
  effort: Effort | null;
  draft: string;
  /** changes whenever the visible conversation changes (last message id + status) */
  headKey: string;
  streaming: boolean;
  local: LocalCtxIn;
}
/** Context usage for the composer: server value (debounced POST with the draft) or a local estimate. null = hidden. */
export function useContextUsage(a: CtxArgs): ContextUsage | null {
  const [server, setServer] = useState<{ convId: string; u: ContextUsage } | null>(null);
  const [off, setOff] = useState(unsupported);
  const seq = useRef(0);
  const limitsSig = JSON.stringify(a.local.settings?.contextLimits || null);
  const local = useMemo(() => localUsage(a.local),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.local.settings?.systemPrompt, limitsSig, a.local.projectPrompt, a.local.providerId, a.local.model, a.local.backendLimit, a.local.draft]);

  useEffect(() => {
    if (!a.v3 || !a.convExists || off || a.streaming) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const body: any = { draft: a.draft };
        if (a.providerId) body.providerId = a.providerId;
        if (a.model) body.model = a.model;
        if (a.effort) body.effort = a.effort;
        const u = await api.contextDraft(a.convId, body);
        if (mine === seq.current && u && typeof u.total === 'number') setServer({ convId: a.convId, u });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) {
          unsupported = true; setOff(true);
        }
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.v3, a.convId, a.convExists, a.providerId, a.model, a.effort, a.draft, a.headKey, a.streaming, off, limitsSig, a.local.settings?.systemPrompt]);

  if (!a.v3 || off) return null;
  if (a.convExists && server && server.convId === a.convId) {
    // keep the server's numbers but apply a locally edited override immediately
    return rememberLimit(a.providerId, a.model, server.u);
  }
  return rememberLimit(a.providerId, a.model, local);
}

/* ---------- give the rejected message text back to the composer ---------- */
type Restore = (convId: string, text: string) => void;
const restorers = new Set<Restore>();
export function onRestoreDraft(f: Restore) { restorers.add(f); return () => { restorers.delete(f); }; }
export function restoreDraft(convId: string, text: string) { restorers.forEach((f) => f(convId, text)); }
