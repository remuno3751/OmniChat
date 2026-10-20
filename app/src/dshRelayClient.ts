// Module-level controller for the DshRelay (web only). Holds at most one running relay.
// Nothing runs at import time; the relay starts only when DshRelayHost calls syncDshRelay().
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { DshRelay, type RelayStatus, type WsFactory } from './dshRelay';
import { desktopDshFrameUrl, frameWsFactory, iframeHost } from './desktopFrameWs';
import { DshPairRequest, type PairRequestStatus } from './dshPairRequest';

export interface DshRelayConfig {
  port: number;
  pairing: string;
  bridgeName: string;
  serverUrl: string;
  token: string;
}

let relay: DshRelay | null = null;
let relayKey = '';
let current: RelayStatus | null = null;
let firstPairPending = false;
const listeners = new Set<() => void>();

let pairRequest: DshPairRequest | null = null;
let pairStatus: PairRequestStatus = { state: 'idle' };
const pairListeners = new Set<() => void>();

const wsFactory = (url: string): any => new WebSocket(url) as any;

/** Pairing request socket: through the desktop shell's own-origin frame when this page is served by the server (the plugin refuses that origin directly). */
let frameFactory: WsFactory | null = null;
function pairWsFactory(): WsFactory {
  const frameUrl = typeof window !== 'undefined' ? desktopDshFrameUrl(window) : null;
  if (!frameUrl) return wsFactory;
  frameFactory ||= frameWsFactory(iframeHost(frameUrl));
  return frameFactory;
}

export function isRelaySupported(): boolean {
  return Platform.OS === 'web' && typeof WebSocket !== 'undefined';
}

function publish(s: RelayStatus | null): void {
  current = s;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Current relay status, or null when no relay is running. */
export function useDshRelayStatus(): RelayStatus | null {
  return useSyncExternalStore(subscribe, () => current);
}

function publishPair(s: PairRequestStatus): void {
  pairStatus = s;
  pairListeners.forEach((l) => l());
}

function subscribePair(l: () => void): () => void {
  pairListeners.add(l);
  return () => {
    pairListeners.delete(l);
  };
}

/** Status of the approve-in-DSH pairing request (`idle` when none is running). */
export function useDshPairRequestStatus(): PairRequestStatus {
  return useSyncExternalStore(subscribePair, () => pairStatus);
}

function stopPairRequest(): void {
  const old = pairRequest;
  pairRequest = null;
  try {
    old?.cancel();
  } catch {
    /* cancel does not throw; keep the UI safe anyway */
  }
}

/**
 * Asks the DSH plugin on 127.0.0.1:`port` to approve this app. On approval `onApproved` gets the
 * pairing token once. Replaces any request already running. Never throws.
 */
export function startDshPairRequest(opts: { port: number; clientName: string; onApproved: (token: string) => void }): void {
  stopPairRequest();
  const req: DshPairRequest = new DshPairRequest({
    port: opts.port,
    clientName: opts.clientName,
    wsFactory: pairWsFactory(),
    onChange: (s) => {
      if (pairRequest !== req) return; // stale instance
      publishPair(s);
    },
    onApproved: (token) => {
      if (pairRequest !== req) return;
      pairRequest = null;
      opts.onApproved(token);
    },
  });
  pairRequest = req;
  publishPair({ state: 'connecting' });
  try {
    req.start();
  } catch {
    if (pairRequest === req) {
      pairRequest = null;
      publishPair({ state: 'error', error: 'unreachable' });
    }
  }
}

/** Cancels a running pairing request and returns the status to idle. */
export function cancelDshPairRequest(): void {
  stopPairRequest();
  if (pairStatus.state !== 'idle') publishPair({ state: 'idle' });
}

/** Marks the next relay start as a first pairing (sends `pair: true` in hello). Cleared after the first ready. */
export function connectDshRelay(): void {
  firstPairPending = true;
}

export function retryDshRelay(): void {
  try {
    relay?.retry();
  } catch {
    /* relay does not throw; keep the UI safe anyway */
  }
}

export function stopDshRelay(): void {
  const old = relay;
  relay = null;
  relayKey = '';
  try {
    old?.stop();
  } catch {
    /* ignore */
  }
  publish(null);
}

/** Starts, restarts or stops the relay so that it matches `cfg` (null = stopped). Never throws. */
export function syncDshRelay(cfg: DshRelayConfig | null): void {
  if (!cfg) {
    if (relay) stopDshRelay();
    return;
  }
  const key = [cfg.port, cfg.pairing, cfg.bridgeName, cfg.serverUrl, cfg.token].join('\u0000');
  if (relay && key === relayKey) return;
  if (relay) stopDshRelay();
  try {
    const r: DshRelay = new DshRelay({
      port: cfg.port,
      pairing: cfg.pairing,
      bridgeName: cfg.bridgeName,
      serverUrl: cfg.serverUrl,
      token: cfg.token,
      firstPair: firstPairPending,
      version: 'app',
      localFactory: wsFactory,
      serverFactory: wsFactory,
      onStatus: (s) => {
        if (relay !== r) return; // stale instance
        if (s.local === 'connected') firstPairPending = false;
        publish(s);
      },
    });
    relay = r;
    relayKey = key;
    r.start();
  } catch {
    relay = null;
    relayKey = '';
    publish(null);
  }
}
