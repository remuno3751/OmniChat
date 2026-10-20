import { useSyncExternalStore } from 'react';
import type { Route } from './protocol';
import { t } from './i18n';

/** Connection / latency state (not persisted). Updated by socket.ts. */
export interface Net {
  /** last RTTs in ms (newest last, max 6) */
  rtts: number[];
  /** where the last RTT came from */
  via: 'ws' | 'http' | null;
  route: Route | null;
  /** serverTime - clientTime at hello (ms); null when unknown */
  offsetMs: number | null;
  /** the server answers pings over the WebSocket (phase 2) */
  wsPing: boolean;
  /** result of the last HTTP /ping fallback: true reachable, false not, null unknown */
  httpUp: boolean | null;
  /** epoch ms of the next scheduled reconnect attempt (null = none) */
  retryAt: number | null;
  attempt: number;
}

const blank = (): Net => ({ rtts: [], via: null, route: null, offsetMs: null, wsPing: false, httpUp: null, retryAt: null, attempt: 0 });
let net: Net = blank();
const subs = new Set<() => void>();
export const getNet = () => net;
export function patchNet(p: Partial<Net>) {
  net = { ...net, ...p };
  subs.forEach((f) => f());
}
export function pushRtt(ms: number, via: 'ws' | 'http') {
  patchNet({ rtts: [...net.rtts, Math.max(0, Math.round(ms))].slice(-6), via });
}
export function resetNet() {
  net = blank();
  subs.forEach((f) => f());
}
export function useNet<T>(sel: (n: Net) => T): T {
  return useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => sel(net));
}

export const avgRtt = (r: number[]) => (r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null);
export type LatState = 'good' | 'slow' | 'bad' | 'off';
export function latState(avg: number | null, connected: boolean): LatState {
  if (!connected) return 'off';
  if (avg == null) return 'good';
  return avg < 150 ? 'good' : avg <= 500 ? 'slow' : 'bad';
}
/** Route names in the active language. Looked up on each access, so they follow the device language. */
export const ROUTE_LABEL: Record<Route, string> = new Proxy({} as Record<Route, string>, {
  get: (_, k) => (typeof k === 'string' ? t(`route.${k}`) : undefined),
});
