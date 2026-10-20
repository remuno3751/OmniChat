import { useEffect, useState } from 'react';
import { api, ApiError, type BridgeInfo } from './api';

const POLL_MS = 15000;

/**
 * The PC bridges currently connected to the server (GET /bridges), refreshed every 15 s while `enabled`.
 * null = not loaded yet or not available (old server: 404 stops polling). A bridge missing from the list is offline.
 */
export function useBridges(enabled: boolean): BridgeInfo[] | null {
  const [bridges, setBridges] = useState<BridgeInfo[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: any = null;
    const tick = async () => {
      try {
        const r = await api.bridges();
        if (!alive) return;
        setBridges(Array.isArray(r?.bridges) ? r.bridges : []);
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 404) return;
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [enabled]);
  return bridges;
}
