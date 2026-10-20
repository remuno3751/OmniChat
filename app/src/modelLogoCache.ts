import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { getServerUrl, getToken } from './api';
import { useDevice } from './deviceSettings';

/**
 * Real maker logos for models, fetched from the server's GET /model-logo (which looks them up on huggingface.co).
 * Module-level cache: one load per model+publisher, at most MAX_CONCURRENT loads at a time, never throws.
 * Callers fall back to the built-in badge (ModelLogo) whenever the hook returns null.
 */

/** An <Image> source: on web a blob URL, on native the server URL plus the auth header. */
export interface LogoSource {
  uri: string;
  headers?: Record<string, string>;
}

interface Entry {
  status: 'loading' | 'ok' | 'none';
  source?: LogoSource;
  /** epoch ms when a 'none' entry was recorded */
  at?: number;
  /** true when the 'none' came from a network / non-404 error (retryable), false for 404 or a failed render */
  network?: boolean;
}

const MAX_CONCURRENT = 4;
const RETRY_MS = 60_000;

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queue: { key: string; model: string; publisher?: string }[] = [];
let active = 0;

const keyOf = (model: string, publisher?: string) => `${publisher || ''}|${model}`;

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function set(key: string, entry: Entry) {
  cache.set(key, entry);
  notify();
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    active++;
    load(job.key, job.model, job.publisher).finally(() => {
      active--;
      pump();
    });
  }
}

async function load(key: string, model: string, publisher?: string): Promise<void> {
  try {
    const base = getServerUrl();
    const token = getToken();
    const url = `${base}/model-logo?model=${encodeURIComponent(model)}${publisher ? '&publisher=' + encodeURIComponent(publisher) : ''}`;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // 404 = no logo for this model (permanent for this session); other statuses may be transient
      set(key, { status: 'none', at: Date.now(), network: res.status !== 404 });
      return;
    }
    if (Platform.OS === 'web') {
      const URLc: any = (globalThis as any).URL;
      if (!URLc || typeof URLc.createObjectURL !== 'function') {
        set(key, { status: 'none', at: Date.now(), network: false });
        return;
      }
      const blob = await res.blob();
      set(key, { status: 'ok', source: { uri: URLc.createObjectURL(blob) } });
    } else {
      // native <Image> cannot use a blob URI: hand it the URL and the auth header instead
      set(key, { status: 'ok', source: { uri: url, headers } });
    }
  } catch {
    set(key, { status: 'none', at: Date.now(), network: true });
  }
}

/** Called by ModelLogo when the <Image> fails to render, so the badge fallback shows. */
export function markLogoFailed(model: string, publisher?: string): void {
  try {
    const key = keyOf(model, publisher);
    const cur = cache.get(key);
    const uri = cur?.source?.uri;
    if (uri && Platform.OS === 'web') {
      const URLc: any = (globalThis as any).URL;
      if (URLc && typeof URLc.revokeObjectURL === 'function') URLc.revokeObjectURL(uri);
    }
    set(key, { status: 'none', at: Date.now(), network: false });
  } catch {
    // never throws
  }
}

function request(model: string, publisher?: string): void {
  try {
    if (!model) return;
    const key = keyOf(model, publisher);
    const cur = cache.get(key);
    if (cur) {
      if (cur.status === 'ok' || cur.status === 'loading') return;
      // 'none': only network errors are retried, and only after RETRY_MS
      if (!cur.network || Date.now() - (cur.at ?? 0) < RETRY_MS) return;
    }
    cache.set(key, { status: 'loading' });
    queue.push({ key, model, publisher });
    pump();
  } catch {
    // never throws
  }
}

/**
 * The maker logo for a model, or null (show the badge). Returns null without any request when the
 * `modelLogosOnline` device setting is off. Starts at most one load per model+publisher.
 */
export function useModelLogoUri(model: string, publisher?: string): LogoSource | null {
  const enabled = useDevice((s) => s.modelLogosOnline);
  const key = keyOf(model, publisher);
  const entry = useSyncExternalStore(subscribe, () => cache.get(key));

  useEffect(() => {
    if (enabled) request(model, publisher);
  }, [enabled, model, publisher]);

  if (!enabled) return null;
  if (entry?.status === 'ok' && entry.source) return entry.source;
  return null;
}
