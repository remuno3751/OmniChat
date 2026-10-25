import { consumeStagedAttachments, restoreFailedSend } from './attachmentState';
import { api, getToken } from './api';
import { t } from './i18n';
import type { ClientMsg, ServerMsg } from './protocol';
import { refreshModels } from './ModelPicker';
import { getNet, patchNet, pushRtt, resetNet } from './net';
import { handleModelConflict, rollbackLastSend } from './chatActions';
import { restoreDraft, setOverflowNotice } from './contextState';
import { parseProgress } from './modelLoad';
import { setProgress } from './modelLoadState';
import { addApproval, dropApprovalsFor } from './toolState';
import { applyDelta, applyEphemeralState, applyPhase, applySnapshot, applyToolCall, applySync, applyUpsert, destroyEphemeralLocal, failPending, getState, noteMaintenanceBlocked, patchSettingsLocal, setConnected, setEphemeralSupported, setMaintenance, setV3, setAllowOwnProviders, setSharedProviders } from './store';
import { isMaintenanceCode, parseMaintenance } from './maintenance';
import { codeBridgeErrorKey } from './vscodeBridge';
import { codeErrorKey } from './codeModels';
import { emitCheckpoint, emitNotify } from './v4Events';
import { toast } from './ui/toast';
import { applyBenchDone, applyBenchProgress, applyCompareComplete, applyCompareDelta, applyCompareDone, failCompare } from './devState';

let ws: WebSocket | null = null;
let active = false;
let attempt = 0;
/** when the current socket opened; the backoff only resets once a connection stayed up for 10 s */
let openedAt = 0;
let timer: any = null;
let pingTimer: any = null;
let lastRx = 0;
/** reconnect delays in ms: 1, 2, 5, 10, 30 s (then stays at 30 s) */
const BACKOFF = [1000, 2000, 5000, 10000, 30000];
let onRevoked: (() => void) | null = null;
/** Called when the server closes the socket with 4001 (this device was revoked). */
export function setRevokedHandler(f: (() => void) | null) { onRevoked = f; }
/** Called with the conversation id when an ephemeral chat is destroyed (the UI leaves it if it is open). */
let onEphemeralDestroyed: ((convId: string) => void) | null = null;
export function setEphemeralDestroyedHandler(f: ((convId: string) => void) | null) { onEphemeralDestroyed = f; }

// the first full provider read of this app session (a removed share is only seen by a full read)
let sharedSynced = false;

/**
 * Re-reads the provider list (shared providers have no seq, so only a full read shows a share that was removed),
 * then the model list. Runs on providers-changed, and once per app session after the first sync.
 */
export async function refreshSharedProviders() {
  try {
    const r = await api.sync(0);
    setSharedProviders(r.providers || []);
    if (typeof r.allowOwnProviders === 'boolean') setAllowOwnProviders(r.allowOwnProviders);
    sharedSynced = true;
  } catch {}
  refreshModels(true, true);
}

export async function syncNow() {
  try {
    applySync(await api.sync(getState().lastSeq));
  } catch {}
  if (!sharedSynced) void refreshSharedProviders();
  // detect protocol v3 (an old server answers 404 here)
  try {
    const v = await api.version();
    setV3(v?.name === 'omnichat-server' || getState().v3);
    setEphemeralSupported(v?.ephemeral === true);
  } catch {}
}

function open() {
  if (!active || !getToken()) return;
  let mine: WebSocket;
  try {
    mine = new WebSocket(api.wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = mine;
  mine.onopen = () => {
    openedAt = Date.now();
    lastRx = Date.now();
    patchNet({ retryAt: null, httpUp: true });
    setConnected(true);
    syncNow();
  };
  mine.onmessage = (ev: any) => {
    let m: ServerMsg;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    lastRx = Date.now();
    if (m.type === 'upsert') {
      applyUpsert(m);
      for (const um of m.messages || []) if (um.role === 'assistant' && um.status !== 'streaming') dropApprovalsFor(um.id);
    }
    else if (m.type === 'hello') {
      // route / serverTime only exist on a phase-2 server; that server also answers WS pings
      patchNet({
        route: m.route ?? null,
        wsPing: !!m.route,
        offsetMs: typeof m.serverTime === 'number' ? Math.round(m.serverTime - Date.now()) : null,
      });
      // an old server sends no maintenance field: keep what we have (nothing is shown)
      if (m.maintenance !== undefined) setMaintenance(parseMaintenance(m.maintenance));
      // PROTOCOL-v7: absent on an old server => unknown (the UI keeps showing the add button, as before)
      if (typeof m.allowOwnProviders === 'boolean') setAllowOwnProviders(m.allowOwnProviders);
      tick();
    } else if (m.type === 'pong') {
      if (typeof m.t === 'number') pushRtt(Date.now() - m.t, 'ws');
    }
    else if (m.type === 'maintenance') setMaintenance(parseMaintenance(m.maintenance));
    else if (m.type === 'models_changed') refreshModels(false, true);
    else if (m.type === 'providers-changed') void refreshSharedProviders();
    else if (m.type === 'delta') applyDelta(m.messageId, m.conversationId, m.text, m.kind === 'reasoning' ? 'reasoning' : 'text');
    else if (m.type === 'snapshot') {
      applySnapshot(m.messages || []);
      for (const sm of m.messages || []) if (sm.status !== 'streaming') dropApprovalsFor(sm.id);
    } else if (m.type === 'tool') {
      applyToolCall(m.messageId, m.conversationId, m.call);
      // the call left the pending state (answered here, on another device, timed out or stopped): its prompt is obsolete
      if (m.call && m.call.status !== 'pending') dropApprovalsFor(m.messageId, m.call.name);
    } else if (m.type === 'tool_approval') {
      addApproval({ approvalId: m.approvalId, messageId: m.messageId, conversationId: m.conversationId, tool: m.tool, arguments: m.arguments, permissions: m.permissions || [], protected: m.protected === true, reasons: Array.isArray(m.reasons) ? m.reasons : [] });
    }
    else if (m.type === 'ephemeral_state') {
      applyEphemeralState(m);
      if (typeof m.idleMinutes === 'number' && getState().settings && getState().settings?.ephemeralIdleMinutes !== m.idleMinutes) {
        patchSettingsLocal({ ephemeralIdleMinutes: m.idleMinutes });
      }
    }
    else if (m.type === 'ephemeral_destroyed') {
      const existed = !!getState().conversations[m.conversationId];
      destroyEphemeralLocal(m.conversationId);
      // the end was started here (reason 'ended') is not news; the other reasons are
      if (existed && m.reason !== 'ended') toast(t('eph.destroyed.' + m.reason), 'info');
      onEphemeralDestroyed?.(m.conversationId);
    }
    else if (m.type === 'phase') applyPhase(m);
    else if (m.type === 'notify') emitNotify(m);
    else if (m.type === 'checkpoint' || m.type === 'checkpoint_unavailable') emitCheckpoint(m);
    else if (m.type === 'compare_delta') applyCompareDelta(m.compareId, m.index, m.kind === 'reasoning' ? 'reasoning' : 'text', m.text);
    else if (m.type === 'compare_done') applyCompareDone(m.compareId, m.index, m);
    else if (m.type === 'compare_complete') applyCompareComplete(m.compareId);
    else if (m.type === 'bench_progress') applyBenchProgress(m.runId, m.done, m.total, m.current);
    else if (m.type === 'bench_done') applyBenchDone(m.runId, m.status);
    else if (m.type === 'model_load') {
      // progress of a load policy before a chat turn (PROTOCOL-v7); 'ready' ends the line
      const p = parseProgress(m);
      setProgress(p && p.phase !== 'ready' ? p : null);
    }
    else if (m.type === 'error') {
      // PROTOCOL-v7: the conflict dialog / retry handles these; no generic toast and no failPending
      if (m.code === 'model_conflict' || m.code === 'model_load_failed') {
        handleModelConflict(m);
        return;
      }
      if (isMaintenanceCode(m.code)) {
        // refused by maintenance mode: the banner explains it (no generic toast); the text goes back to the composer
        noteMaintenanceBlocked(m.message || '');
        const back = rollbackLastSend();
        if (back) restoreDraft(back.convId, back.content);
      } else if (m.code === 'model_not_allowed' || m.code === 'quota_exceeded') {
        // PROTOCOL-v7: the admin does not allow this model, or the usage limit is reached (quotas). Same text for a send,
        // a regenerate, a comparison (its card ends with the text) and a benchmark; a send's text goes back to the composer
        const text = m.code === 'quota_exceeded' ? t('quota.exceeded') : t('shared.modelNotAllowed');
        toast(text, 'error');
        const compareId = (m as { compareId?: string }).compareId;
        if (compareId) { failCompare(compareId, text); return; }
        const back = rollbackLastSend();
        if (back) restoreDraft(back.convId, back.content);
      } else if (m.code === 'context_overflow') {
        setOverflowNotice(m.message || t('socket.contextOverflow'));
        const back = rollbackLastSend();
        if (back) restoreDraft(back.convId, back.content);
      } else if (m.code === 'ephemeral_gone') {
        // the chat is no longer live on the server: forget it here too
        if (m.conversationId) destroyEphemeralLocal(m.conversationId);
        toast(t('eph.gone'), 'error');
        if (m.conversationId) onEphemeralDestroyed?.(m.conversationId);
      } else if (codeBridgeErrorKey(m.code) || codeErrorKey(m.message, m.code)) {
        // Code errors: the server text is English or Japanese; the mapped i18n text is shown instead
        toast(t((codeBridgeErrorKey(m.code) ?? codeErrorKey(m.message, m.code))!), 'error');
      } else toast(m.message || t('socket.serverError'), 'error');
      restoreFailedSend(m.code);
      failPending(m.messageId);
    }
  };
  mine.onclose = (ev: any) => {
    if (ws === mine) ws = null;
    setConnected(false);
    patchNet({ wsPing: false });
    setProgress(null);
    if (ev?.code === 4001) {
      active = false;
      onRevoked?.();
      return;
    }
    scheduleReconnect();
  };
  mine.onerror = () => { try { mine.close(); } catch {} };
}

function scheduleReconnect() {
  if (!active || timer) return;
  const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] + Math.random() * 300;
  attempt++;
  patchNet({ retryAt: Date.now() + delay, attempt });
  timer = setTimeout(() => { timer = null; patchNet({ retryAt: null }); open(); }, delay);
}

/** One latency probe: WS ping when the server supports it, else HTTP GET /ping (also the fallback while the WS is down). */
async function tick() {
  if (!active) return;
  const w = ws;
  if (w && w.readyState === 1 && attempt > 0 && Date.now() - openedAt > 10000) { attempt = 0; patchNet({ attempt: 0 }); }
  if (w && w.readyState === 1 && getNet().wsPing) {
    // dead socket: nothing received for 4 ping intervals
    if (Date.now() - lastRx > 20000) { try { w.close(); } catch {} return; }
    try { w.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
    return;
  }
  const t0 = Date.now();
  try {
    const ctl: any = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
    try { await api.ping(ctl?.signal); } finally { if (to) clearTimeout(to); }
    if (!active) return;
    pushRtt(Date.now() - t0, 'http');
    patchNet({ httpUp: true });
  } catch {
    if (active) patchNet({ httpUp: false });
  }
}

/** Drops the current socket (if any) and reconnects immediately, resetting the backoff. */
export function reconnectNow() {
  if (!active) return;
  attempt = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  const w = ws; ws = null;
  if (w) { w.onclose = null; try { w.close(); } catch {} }
  setConnected(false);
  patchNet({ retryAt: null, attempt: 0, wsPing: false });
  open();
}

export function startSocket() {
  stopSocket();
  active = true;
  attempt = 0;
  resetNet();
  open();
  pingTimer = setInterval(tick, 5000);
  const g: any = globalThis;
  if (typeof g.addEventListener === 'function' && !g.__ocNetHook) {
    g.__ocNetHook = true;
    g.addEventListener('online', () => { if (active && !getState().connected) reconnectNow(); });
  }
}
export function stopSocket() {
  active = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  const w = ws; ws = null;
  if (w) { w.onclose = null; try { w.close(); } catch {} }
  setConnected(false);
}
export function wsSend(m: ClientMsg): boolean {
  if (m.type === 'send') { const ids = consumeStagedAttachments(); if (ids) m.attachmentIds = ids; }
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
  return false;
}
