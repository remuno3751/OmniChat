// Desktop pet: the main app publishes the pets' items (one per running or unread conversation, v2) on
// BroadcastChannel('omnichat-pet'); the pet window (the page at /?desktopPet=1, see DesktopPetPage.tsx) listens and
// answers back (dismiss / open). Also the bridge to the desktop shell (window.__OMNICHAT_DESKTOP__).
// See docs/design/V056-DESKTOP-PET.md (追加仕様 v2).
import { useEffect, useState } from 'react';
import { useDevice } from './deviceSettings';
import { resolveLanguage } from './i18n/index';
import { activeToolLabel, activityOf, buildItems, type FinishedInput, type PetItem } from './petItems';
import { DONE_TTL_MS, ERROR_TTL_MS, type PetOutcome } from './petBubble';
import { dismissUnread, finishRun, finishedIds, getUnread, setUnread, unreadList, watchShown } from './petUnread';
import type { PetMode } from './petState';
import { getState, useStore, type State } from './store';
import { onNotify } from './v4Events';

export const PET_CHANNEL = 'omnichat-pet';
/** While items are shown, the state is re-sent this often (the pet window goes idle after 10 s of silence). */
export const PET_HEARTBEAT_MS = 4000;
/** How often the publisher re-checks transient bubbles while something is shown. */
const PET_TICK_MS = 1000;
/** An error notify this recent counts as the run's error when the run ends. */
const ERROR_NOTIFY_WINDOW_MS = 15_000;

/** Messages on PET_CHANNEL. `state` is published by the main app; the others are sent by the pet window. */
export type PetChannelMessage =
  | {
      type: 'state';
      v?: number;
      at: number;
      appFocused?: boolean;
      items?: PetItem[];
      /** the synced active pet (settings.activePetId), for a device that has no pet of its own */
      activePetId?: string | null;
      /** v1 publishers only */
      mode?: PetMode;
      label?: string;
      detail?: string;
    }
  | { type: 'hello' }
  | { type: 'dismiss'; id: string }
  | { type: 'open'; id: string };

export interface DesktopPetBridge {
  petShow?: () => unknown;
  petHide?: () => unknown;
  petDrag?: () => unknown;
  petStatus?: () => unknown;
  /** pet window only: show and focus the main window */
  petFocusApp?: () => unknown;
  /** main window: bring the app to the front (optional) */
  focusMain?: () => unknown;
}

interface RunSnap { id: string; title: string; mode: PetMode; detail: string }

let channel: BroadcastChannel | null = null;
let latest: PetChannelMessage | null = null;
let lastKey = '';
let lastSentAt = 0;
let tick: ReturnType<typeof setInterval> | null = null;
let errorNotifyOff: (() => void) | null = null;

// Inputs from the hook, and what the publisher remembers between them.
let runs: RunSnap[] = [];
let prevRuns = new Map<string, RunSnap>();
let since = new Map<string, number>();
let errorAt = new Map<string, number>();
let transient = new Map<string, { title: string; outcome: PetOutcome; at: number; until: number }>();
let shownId: string | null = null;
let focused = true;
let lang = 'en';
let syncedPetId: string | null = null;
let openFn: ((id: string) => void) | null = null;

/** Running conversations (mode, tool and title) from the store. A JSON string, so the selector stays a primitive. */
function listRuns(s: State): RunSnap[] {
  const ids = new Set([...Object.keys(s.conversations), ...Object.keys(s.messages)]);
  const out: RunSnap[] = [];
  for (const id of ids) {
    const c = s.conversations[id];
    if (!c || c.deleted) continue;
    const mode = activityOf(s.messages[id], c.codeStatus);
    if (!mode) continue;
    out.push({ id, title: c.title ?? '', mode, detail: activeToolLabel(s.messages[id]) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function titleOf(id: string): string {
  return getState().conversations[id]?.title ?? '';
}

/** Opens the channel once (web only), answers the pet window's requests and listens for error notifies. */
function ensureChannel(): BroadcastChannel | null {
  if (!errorNotifyOff) {
    errorNotifyOff = onNotify((f) => {
      if (f.kind === 'error') errorAt.set(f.conversationId, Date.now());
    });
  }
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(PET_CHANNEL);
    channel.onmessage = (e: MessageEvent) => handlePetMessage(e.data as PetChannelMessage | undefined);
  }
  return channel;
}

function handlePetMessage(m: PetChannelMessage | undefined): void {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'hello') {
    channel?.postMessage(latest ?? emptyState());
  } else if (m.type === 'dismiss' && typeof m.id === 'string') {
    setUnread(dismissUnread(getUnread(), m.id));
    publish();
  } else if (m.type === 'open' && typeof m.id === 'string') {
    openFromPet(m.id);
  }
}

function openFromPet(id: string): void {
  setUnread(dismissUnread(getUnread(), id));
  try { (globalThis as any).window?.__OMNICHAT_DESKTOP__?.focusMain?.(); } catch { /* shell gone */ }
  if (getState().conversations[id]) openFn?.(id);
  publish();
}

function emptyState(): PetChannelMessage {
  return { type: 'state', v: 2, at: Date.now(), appFocused: focused, items: [], activePetId: syncedPetId };
}

function startTick(): void {
  if (!tick) tick = setInterval(publish, PET_TICK_MS);
}

function stopTick(): void {
  if (tick) { clearInterval(tick); tick = null; }
}

/** Builds the items from the current inputs and sends them when they changed (or as a heartbeat). */
function publish(): void {
  const now = Date.now();
  for (const [id, t] of transient) if (t.until <= now) transient.delete(id);
  const finished: FinishedInput[] = [];
  for (const u of unreadList(getUnread())) {
    if (!getState().conversations[u.id]) continue;
    finished.push({ id: u.id, title: titleOf(u.id), outcome: u.outcome, at: u.at, unread: true });
  }
  for (const [id, t] of transient) finished.push({ id, title: t.title, outcome: t.outcome, at: t.at, unread: false });
  const items = buildItems(runs.map((r) => ({ ...r, at: since.get(r.id) ?? now })), finished, lang);
  const key = JSON.stringify(items.map((i) => [i.id, i.mode, i.label, i.unread, i.title, i.detail]));
  const msg: PetChannelMessage = { type: 'state', v: 2, at: now, appFocused: focused, items, activePetId: syncedPetId };
  latest = msg;
  if (key !== lastKey || (items.length > 0 && now - lastSentAt >= PET_HEARTBEAT_MS)) {
    lastKey = key;
    lastSentAt = now;
    ensureChannel()?.postMessage(msg);
  }
  if (items.length) startTick(); else stopTick();
}

/** New inputs (runs, the shown conversation, focus, language, synced pet): finishes become unread or transient. */
function applyInputs(next: { runs: RunSnap[]; shown: string | null; focused: boolean; lang: string; synced: string | null }): void {
  const now = Date.now();
  const nowIds = next.runs.map((r) => r.id);
  for (const id of finishedIds(prevRuns.keys(), nowIds)) {
    const failed = getState().conversations[id]?.codeStatus === 'error' || (errorAt.get(id) ?? 0) > now - ERROR_NOTIFY_WINDOW_MS;
    const outcome: PetOutcome = failed ? 'error' : 'done';
    errorAt.delete(id);
    since.delete(id);
    const watching = next.focused && next.shown === id;
    if (watching) transient.set(id, { title: titleOf(id), outcome, at: now, until: now + (failed ? ERROR_TTL_MS : DONE_TTL_MS) });
    setUnread(finishRun(getUnread(), { id, outcome, at: now }, watching));
  }
  for (const id of nowIds) if (!prevRuns.has(id)) since.set(id, now);
  prevRuns = new Map(next.runs.map((r) => [r.id, r]));
  runs = next.runs;
  shownId = next.shown;
  focused = next.focused;
  lang = next.lang;
  syncedPetId = next.synced;
  setUnread(watchShown(getUnread(), shownId, focused));
  publish();
}

/** The shell bridge when it can show the pet window (the main app, desktop only); otherwise null. */
export function desktopBridge(): DesktopPetBridge | null {
  const w = typeof window !== 'undefined' ? (window as any) : undefined;
  const b = w?.__OMNICHAT_DESKTOP__;
  return b && typeof b.petShow === 'function' ? (b as DesktopPetBridge) : null;
}

function callBridge(name: keyof DesktopPetBridge): void {
  const b = desktopBridge();
  const fn = b?.[name];
  if (!b || typeof fn !== 'function') return;
  try { void Promise.resolve(fn.call(b)).catch(() => {}); } catch { /* the shell is gone */ }
}

/** Opens the desktop pet window (the shell remembers its position). No-op outside the desktop app. */
export function showDesktopPet(): void {
  callBridge('petShow');
}

/** Closes the desktop pet window. No-op outside the desktop app. */
export function hideDesktopPet(): void {
  callBridge('petHide');
}

/** True for the pet window's page: the URL has `desktopPet=1` (the shell opens it as /?desktopPet=1). */
export function isDesktopPetPage(): boolean {
  return typeof location !== 'undefined' && /[?&]desktopPet=1(&|$)/.test(location.search || '');
}

/** Whether the app window has the user's focus (visible and focused). Native (no document): always. */
export function appFocused(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function useAppFocused(): boolean {
  const [f, setF] = useState(appFocused);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const upd = () => setF(appFocused());
    window.addEventListener('focus', upd);
    window.addEventListener('blur', upd);
    document?.addEventListener?.('visibilitychange', upd);
    return () => {
      window.removeEventListener('focus', upd);
      window.removeEventListener('blur', upd);
      document?.removeEventListener?.('visibilitychange', upd);
    };
  }, []);
  return f;
}

/**
 * Publishes the pet items of all running and unread conversations. Mount once (App).
 * `displayedId` is the conversation on screen (null when another screen is shown); `openConv` opens one (pet click).
 */
export function usePublishPetState(displayedId: string | null, openConv: (id: string) => void): void {
  const language = resolveLanguage(useDevice((s) => s.language));
  const focus = useAppFocused();
  const runsJson = useStore((s) => JSON.stringify(listRuns(s)));
  const synced = useStore((s) => s.settings?.activePetId ?? null);
  openFn = openConv;

  useEffect(() => { ensureChannel(); }, []);
  useEffect(() => {
    applyInputs({ runs: JSON.parse(runsJson) as RunSnap[], shown: displayedId, focused: focus, lang: language, synced });
  }, [runsJson, displayedId, focus, language, synced]);
  useEffect(() => () => stopTick(), []);
}
