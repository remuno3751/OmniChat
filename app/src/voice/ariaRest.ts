/**
 * Small REST helper for Aria's HTTP API (docs/design/ARIA-VOICE.md). Pure apart from `fetch`:
 * the token goes only into the Authorization header and is never logged or put in an error message.
 */

/** http(s) origin of the configured Aria URL (ws / wss / http / https accepted); null when it cannot be one. */
export function ariaHttpBase(url: string): string | null {
  const t = (url || '').trim();
  const m = /^(wss?|https?):\/\/([^/?#]+)/i.exec(t);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return `${scheme === 'ws' || scheme === 'http' ? 'http' : 'https'}://${m[2]}`;
}

export class AriaHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'AriaHttpError';
  }
}

export interface AriaFetchOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  /** JSON body (object) or a raw body (ArrayBuffer / Blob / Uint8Array) with `contentType` */
  body?: unknown;
  contentType?: string;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** injected in tests */
  fetchImpl?: typeof fetch;
}

function isRaw(b: unknown): b is ArrayBuffer | Blob | Uint8Array {
  return (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) || (typeof Blob !== 'undefined' && b instanceof Blob) || b instanceof Uint8Array;
}

/** JSON request to `${base}${path}`. Rejects with AriaHttpError (status 0 = network / timeout). */
export async function ariaFetchJson<T = unknown>(base: string, path: string, o: AriaFetchOptions = {}): Promise<T> {
  const f = o.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.body !== undefined) {
    if (isRaw(o.body)) { body = o.body as BodyInit; headers['content-type'] = o.contentType ?? 'application/octet-stream'; }
    else { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 15000);
  const onAbort = () => ac.abort();
  o.signal?.addEventListener('abort', onAbort);
  try {
    const res = await f(`${base}${path}`, { method: o.method ?? 'GET', headers, body, signal: ac.signal });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = (json && (json.detail?.message ?? json.detail ?? json.error?.message ?? json.error ?? json.message)) || `HTTP ${res.status}`;
      throw new AriaHttpError(res.status, typeof msg === 'string' ? msg.slice(0, 300) : `HTTP ${res.status}`, typeof json?.code === 'string' ? json.code : undefined);
    }
    return json as T;
  } catch (e) {
    if (e instanceof AriaHttpError) throw e;
    throw new AriaHttpError(0, ac.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}
