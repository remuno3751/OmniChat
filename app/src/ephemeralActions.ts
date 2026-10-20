import { Platform } from 'react-native';
import { api, getServerUrl, getToken, uuid } from './api';
import { getEphemeralIds, destroyEphemeralLocal } from './store';
import { newEphemeralId } from './ephemeral';
import { wsSend } from './socket';

/** A fresh id for a new ephemeral chat (eph_ prefix + uuid). */
export function startEphemeralId(): string {
  return newEphemeralId(uuid);
}

/**
 * Ends one ephemeral chat: tells the server (WS frame, or REST when the socket is down), then forgets it locally.
 * Errors are swallowed: the local copy is removed either way.
 */
export async function endEphemeral(convId: string): Promise<void> {
  let sent = false;
  try { sent = wsSend({ type: 'ephemeral_end', conversationId: convId }); } catch {}
  if (!sent) {
    try { await api.endEphemeral(convId); } catch {}
  }
  destroyEphemeralLocal(convId);
}

/** Ends every ephemeral chat held in memory. */
export async function endAllEphemeral(): Promise<void> {
  await Promise.all(getEphemeralIds().map((id) => endEphemeral(id)));
}

/**
 * Web only: when the page is left (closed, reloaded, navigated away) every live ephemeral chat of this tab is ended.
 * Sends the WS frame and a keepalive DELETE (the socket may not survive the unload). Returns the unsubscribe function.
 * No-op (returns a no-op) on native.
 */
export function installEphemeralLifecycle(): () => void {
  const g: any = globalThis;
  if (Platform.OS !== 'web' || typeof g.addEventListener !== 'function') return () => {};
  const onLeave = () => {
    for (const id of getEphemeralIds()) {
      try { wsSend({ type: 'ephemeral_end', conversationId: id }); } catch {}
      try {
        const tok = getToken();
        fetch(getServerUrl() + '/conversations/' + encodeURIComponent(id), {
          method: 'DELETE',
          keepalive: true,
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        }).catch(() => {});
      } catch {}
    }
  };
  g.addEventListener('pagehide', onLeave);
  g.addEventListener('beforeunload', onLeave);
  return () => {
    g.removeEventListener?.('pagehide', onLeave);
    g.removeEventListener?.('beforeunload', onLeave);
  };
}
