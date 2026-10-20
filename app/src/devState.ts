// Phase-4 developer state: feature availability probes, live compare run, bench progress, JSON helpers.
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, uuid } from './api';
import { apiDev } from './apiDev';
import type { CompareResultBody, CompareTarget, Metrics, ResponseFormat } from './protocol';
import { t } from './i18n';
import { wsSend } from './socket';
import { useStore } from './store';

// ---------- availability (old server => 404 => developer entries hidden) ----------
type Avail = 'unknown' | 'yes' | 'no';
export type DevFeature = 'compare' | 'bench' | 'config';
const avail: Record<DevFeature, Avail> = { compare: 'unknown', bench: 'unknown', config: 'unknown' };
let availVer = 0;
const availSubs = new Set<() => void>();
const setAvail = (k: DevFeature, v: Avail) => { if (avail[k] !== v) { avail[k] = v; availVer++; availSubs.forEach((f) => f()); } };
export function resetDevAvail() { (Object.keys(avail) as DevFeature[]).forEach((k) => { avail[k] = 'unknown'; }); availVer++; availSubs.forEach((f) => f()); }

const probing = new Set<DevFeature>();
async function probe(k: DevFeature) {
  if (avail[k] !== 'unknown' || probing.has(k)) return;
  probing.add(k);
  try {
    if (k === 'compare') await apiDev.comparisons();
    else if (k === 'bench') await apiDev.benchSets();
    else await apiDev.exportConfig('json');
    setAvail(k, 'yes');
  } catch (e: any) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) setAvail(k, 'no');
    else if (e instanceof ApiError && e.status !== 0 && e.status !== 401) setAvail(k, 'yes');
  } finally { probing.delete(k); }
}

/** true once the server answered the feature's endpoint (developer mode only). */
export function useDevAvail(k: DevFeature | 'any'): boolean {
  const dev = useStore((s) => !!s.settings?.devMode && s.v3);
  useSyncExternalStore((f) => { availSubs.add(f); return () => { availSubs.delete(f); }; }, () => availVer);
  useEffect(() => {
    if (!dev) return;
    if (k === 'any') { probe('compare'); probe('bench'); } else probe(k);
  }, [dev, k]);
  if (!dev) return false;
  return k === 'any' ? avail.compare === 'yes' || avail.bench === 'yes' : avail[k] === 'yes';
}

// ---------- live comparison ----------
export interface CompareCol {
  status: 'waiting' | 'running' | 'done' | 'error' | 'stopped';
  content: string; reasoning: string; metrics: Metrics | null; error?: string;
}
export interface CompareRun {
  compareId: string; prompt: string; systemPrompt: string | null; targets: CompareTarget[]; sequential: boolean;
  cols: CompareCol[]; complete: boolean; startedAt: number;
}
let run: CompareRun | null = null;
const runSubs = new Set<() => void>();
const setRun = (r: CompareRun | null) => { run = r; runSubs.forEach((f) => f()); };
export const getCompareRun = () => run;
export const useCompareRun = (): CompareRun | null => useSyncExternalStore((f) => { runSubs.add(f); return () => { runSubs.delete(f); }; }, () => run);

export function startCompare(o: { prompt: string; systemPrompt: string | null; targets: CompareTarget[]; sequential: boolean }): string {
  const compareId = uuid();
  const msg: any = { type: 'compare', compareId, prompt: o.prompt, targets: o.targets, sequential: o.sequential };
  if (o.systemPrompt) msg.systemPrompt = o.systemPrompt;
  if (!wsSend(msg)) return t('dev.notConnected');
  setRun({
    compareId, prompt: o.prompt, systemPrompt: o.systemPrompt, targets: o.targets, sequential: o.sequential, complete: false, startedAt: Date.now(),
    cols: o.targets.map(() => ({ status: 'waiting', content: '', reasoning: '', metrics: null })),
  });
  return '';
}
export function stopCompare() {
  if (!run || run.complete) return;
  if (!wsSend({ type: 'compare_stop', compareId: run.compareId })) {
    // socket is down: nothing more will arrive, finish locally
    setRun({ ...run, complete: true, cols: run.cols.map((c) => (c.status === 'running' || c.status === 'waiting' ? { ...c, status: 'stopped' } : c)) });
  }
}
export function clearCompareRun() { if (run?.complete) setRun(null); }
/** A refused comparison (model_not_allowed, quota_exceeded): the run ends here, every column still waiting shows the message. */
export function failCompare(compareId: string, message: string) {
  if (!run || run.compareId !== compareId) return;
  setRun({ ...run, complete: true, cols: run.cols.map((c) => (c.status === 'waiting' || c.status === 'running' ? { ...c, status: 'error' as const, error: message } : c)) });
}

function patchCol(compareId: string, index: number, f: (c: CompareCol) => CompareCol) {
  if (!run || run.compareId !== compareId || !run.cols[index]) return;
  const cols = run.cols.slice();
  cols[index] = f(cols[index]);
  setRun({ ...run, cols });
}
export function applyCompareDelta(compareId: string, index: number, kind: 'text' | 'reasoning', text: string) {
  patchCol(compareId, index, (c) => (kind === 'reasoning'
    ? { ...c, status: 'running', reasoning: c.reasoning + text }
    : { ...c, status: 'running', content: c.content + text }));
}
export function applyCompareDone(compareId: string, index: number, r: CompareResultBody) {
  patchCol(compareId, index, (c) => ({
    status: r.status || 'done', content: r.content ?? c.content, reasoning: r.reasoning ?? c.reasoning, metrics: r.metrics ?? null, error: r.error,
  }));
}
export function applyCompareComplete(compareId: string) {
  if (!run || run.compareId !== compareId) return;
  setRun({ ...run, complete: true, cols: run.cols.map((c) => (c.status === 'waiting' || c.status === 'running' ? { ...c, status: 'stopped' } : c)) });
}

// ---------- benchmark progress ----------
export interface BenchProg { done: number; total: number; current?: string | null; status?: string }
let prog: Record<string, BenchProg> = {};
const progSubs = new Set<() => void>();
const emitProg = () => progSubs.forEach((f) => f());
export function applyBenchProgress(runId: string, done: number, total: number, current?: string | null) {
  prog = { ...prog, [runId]: { ...prog[runId], done, total, current } };
  emitProg();
}
export function applyBenchDone(runId: string, status: string) {
  const old = prog[runId];
  prog = { ...prog, [runId]: { ...old, done: old?.total ?? old?.done ?? 0, total: old?.total ?? 0, status } };
  emitProg();
}
export const useBenchProgress = (): Record<string, BenchProg> => useSyncExternalStore((f) => { progSubs.add(f); return () => { progSubs.delete(f); }; }, () => prog);

// ---------- misc helpers ----------
export const isReservedKey = (k: string) => ['model', 'messages', 'stream', 'tools', 'stream_options', 'response_format'].includes(k);

/** Pretty-printed JSON when the whole text is a JSON object/array (else null). */
export function prettyJson(text: string): string | null {
  const s = text.trim();
  if (!s || s.length > 200000 || (s[0] !== '{' && s[0] !== '[')) return null;
  try { const v = JSON.parse(s); return typeof v === 'object' && v ? JSON.stringify(v, null, 2) : null; } catch { return null; }
}

export type { ResponseFormat };
