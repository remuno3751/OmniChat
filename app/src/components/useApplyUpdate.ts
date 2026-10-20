import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { api, ApiError, getServerUrl } from '../api';
import { t } from '../i18n';
import { toast } from '../ui/toast';
import { updateErrorText } from '../updateState';
import type { UpdateStatus } from '../updateTypes';

/**
 * Shared server-update progress flow (used by Settings > Updates and by the update popup).
 * Only one update runs at a time; the state lives at module level so every screen shows the same progress.
 *
 * Flow: POST /update/apply -> poll GET /update/status every 2 s (phase + progress) -> the server restarts
 * (the request fails: "restarting") -> poll GET /version until it answers with another version -> done.
 * A failed or rolled-back update shows the server message until the user presses OK (api.updateAck).
 */

export type ApplyPhase = 'idle' | 'starting' | 'working' | 'restarting' | 'done' | 'failed';

export interface ApplyView {
  phase: ApplyPhase;
  /** server phase while working ('downloading', 'verifying', ...) */
  serverPhase: string | null;
  progress: number | null;
  /** version being installed */
  target: string | null;
  /** version running before the update (used to recognise the restarted server) */
  from: string | null;
  /** i18n key of the error to show (null when the message is the server text) */
  errorKey: string | null;
  /** raw server message (rollback or failure text), shown as is */
  errorMessage: string | null;
}

const IDLE: ApplyView = { phase: 'idle', serverPhase: null, progress: null, target: null, from: null, errorKey: null, errorMessage: null };
const POLL_MS = 2000;
/** Give up waiting for the server after this long (the update is then checked by hand). */
const RESTART_TIMEOUT_MS = 6 * 60_000;

let view: ApplyView = IDLE;
let runId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let startedAt = 0;
const listeners = new Set<() => void>();

function set(next: Partial<ApplyView>) {
  view = { ...view, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getApplyView(): ApplyView {
  return view;
}

/** The apply progress; re-renders on every change. */
export function useApplyView(): ApplyView {
  return useSyncExternalStore(subscribe, getApplyView);
}

/** True while an update is running or just finished (the popup and banners stay quiet). */
export function isApplyActive(v: ApplyView = view): boolean {
  return v.phase === 'starting' || v.phase === 'working' || v.phase === 'restarting' || v.phase === 'done';
}

/** The GET /version answer (no auth), or null when the server does not answer. Never throws. */
export async function fetchServerVersion(): Promise<string | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => ctrl?.abort(), 5000);
  try {
    const res = await fetch(`${getServerUrl().replace(/\/+$/, '')}/version`, { signal: ctrl?.signal });
    if (!res.ok) return null;
    const j: any = await res.json();
    return typeof j?.version === 'string' ? j.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Maps a failed API call to an i18n key (no server text is shown for these). */
function errorKeyFor(e: unknown): string {
  const status = e instanceof ApiError ? e.status : -1;
  const code = status === 0 ? 'network' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 409 ? 'busy' : 'other';
  return updateErrorText({ code }).key;
}

function fail(id: number, errorKey: string | null, errorMessage: string | null) {
  if (id !== runId) return;
  clearTimer();
  set({ phase: 'failed', serverPhase: null, progress: null, errorKey, errorMessage });
}

function finish(id: number, version: string) {
  if (id !== runId) return;
  clearTimer();
  set({ phase: 'done', serverPhase: null, progress: null });
  const web = Platform.OS === 'web';
  toast(t(web ? 'update.done' : 'update.doneNoReload', { version }), 'ok');
  if (web) {
    // the web client is served by the server: reload to get the new frontend
    setTimeout(() => {
      try { (globalThis as any).location?.reload(); } catch {}
    }, 1500);
  } else {
    setTimeout(() => { if (view.phase === 'done') set(IDLE); }, 4000);
  }
}

function schedule(id: number, mode: 'status' | 'version', delay = POLL_MS) {
  clearTimer();
  timer = setTimeout(() => { void poll(id, mode); }, delay);
}

async function poll(id: number, mode: 'status' | 'version') {
  if (id !== runId || (view.phase !== 'working' && view.phase !== 'restarting')) return;
  if (Date.now() - startedAt > RESTART_TIMEOUT_MS) {
    fail(id, 'update.restartTimeout', null);
    return;
  }
  if (mode === 'status') {
    let s: UpdateStatus;
    try {
      s = await api.updateStatus();
    } catch {
      // no answer: the server is restarting (or unreachable); wait for /version instead
      if (id !== runId) return;
      set({ phase: 'restarting', serverPhase: 'restarting' });
      schedule(id, 'version');
      return;
    }
    if (id !== runId) return;
    const a = s.lastApply;
    if (a && a.status === 'failed' && a.at >= startedAt - 2000) {
      // rolled back (or failed after the swap): the server message says what happened
      fail(id, null, a.message);
      return;
    }
    if (s.phase === 'error') {
      fail(id, s.lastError ? updateErrorText(s.lastError).key : 'update.err.other', null);
      return;
    }
    if (view.from && s.current !== view.from && s.phase === 'idle') {
      finish(id, s.current);
      return;
    }
    const restarting = s.phase === 'restarting';
    set({ phase: restarting ? 'restarting' : 'working', serverPhase: s.phase, progress: s.progress });
    schedule(id, 'status');
    return;
  }
  // version mode: the server is restarting
  const v = await fetchServerVersion();
  if (id !== runId) return;
  if (v && view.from && v !== view.from) {
    finish(id, v);
    return;
  }
  // an answer with the old version: check the status (it may show a rollback); no answer: keep waiting
  schedule(id, v ? 'status' : 'version');
}

/**
 * Starts the update to `target` (admin only). Resolves when the request was accepted or failed.
 * `from` is the version running now. Ignored while an update is already running.
 */
export async function startApply(target: string, from: string): Promise<void> {
  if (view.phase === 'starting' || view.phase === 'working' || view.phase === 'restarting') return;
  const id = ++runId;
  clearTimer();
  startedAt = Date.now();
  set({ phase: 'starting', serverPhase: null, progress: null, target, from, errorKey: null, errorMessage: null });
  try {
    await api.updateApply(target);
  } catch (e) {
    fail(id, errorKeyFor(e), null);
    return;
  }
  if (id !== runId) return;
  set({ phase: 'working' });
  schedule(id, 'status');
}

/** The user pressed OK on a failure: acknowledge it on the server and hide it. Never throws. */
export async function dismissApplyFailure(): Promise<void> {
  runId++;
  clearTimer();
  set(IDLE);
  try {
    await api.updateAck();
  } catch {
    // not an admin or no answer: the failure stays in the server state and is shown again next time
  }
}

/** Hook form of the progress flow for components. */
export function useApplyUpdate() {
  const v = useApplyView();
  return { view: v, start: startApply, dismissFailure: dismissApplyFailure, active: isApplyActive(v) };
}
