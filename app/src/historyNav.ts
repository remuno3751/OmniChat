// Tiny navigation glue for the history search (no router in this app): open-search requests,
// "jump to message" target, availability hooks, recent searches, Ctrl/Cmd+K.
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAvail, getAvailVersion, probeAdmin, probeHistory, subscribeAvail } from './apiHistory';

// ---- availability (history search present / caller is admin) ----
export function useHistoryAvailable(): boolean {
  useSyncExternalStore(subscribeAvail, getAvailVersion);
  return getAvail().history !== 'no';
}
export function useIsAdminProbe(): boolean {
  useSyncExternalStore(subscribeAvail, getAvailVersion);
  return getAvail().admin === 'yes';
}
export function useProbes(enabled: boolean, admin = false) {
  useEffect(() => { if (enabled) { probeHistory(); if (admin) probeAdmin(); } }, [enabled, admin]);
}

// ---- open the search screen ----
const searchReq = new Set<() => void>();
export const requestSearch = () => searchReq.forEach((f) => f());
export function onSearchRequest(f: () => void) { searchReq.add(f); return () => { searchReq.delete(f); }; }

/** Ctrl/Cmd+K on web. */
export function useSearchShortcut(enabled: boolean, cb: () => void) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    const doc: any = (globalThis as any).document;
    if (!doc?.addEventListener) return;
    const h = (e: any) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'k') { e.preventDefault(); cb(); }
    };
    doc.addEventListener('keydown', h);
    return () => doc.removeEventListener('keydown', h);
  }, [enabled, cb]);
}

// ---- jump to a message after opening a result ----
export interface Jump { convId: string; messageId: string; ts: number }
let jump: Jump | null = null;
const jumpSubs = new Set<() => void>();
export function setJump(j: { convId: string; messageId: string } | null) {
  jump = j ? { ...j, ts: Date.now() } : null;
  jumpSubs.forEach((f) => f());
}
export const getJump = () => (jump && Date.now() - jump.ts < 120000 ? jump : null);
export function useJump(): Jump | null {
  return useSyncExternalStore((f) => { jumpSubs.add(f); return () => { jumpSubs.delete(f); }; }, () => jump) && getJump();
}

// ---- recent searches ----
const K_RECENT = 'omnichat.recentSearches';
export async function loadRecent(): Promise<string[]> {
  try { const r = await AsyncStorage.getItem(K_RECENT); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 10) : []; } catch { return []; }
}
export async function addRecent(q: string): Promise<string[]> {
  const v = q.trim();
  const cur = await loadRecent();
  if (!v) return cur;
  const next = [v, ...cur.filter((x) => x !== v)].slice(0, 10);
  try { await AsyncStorage.setItem(K_RECENT, JSON.stringify(next)); } catch {}
  return next;
}
export async function clearRecent(): Promise<void> {
  try { await AsyncStorage.removeItem(K_RECENT); } catch {}
}
