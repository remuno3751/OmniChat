/**
 * Shared by the voice settings components: the server context, the error texts and the upload with progress.
 * The token goes only into the Authorization header and never into a text, a log or an error message.
 */
import { getServerUrl, getToken } from '../api';
import { AriaHttpError } from '../voice/ariaRest';
import { isAriaUnreachable, isNotSupportedYet, isVoiceOff, type VoiceApiCtx } from '../voice/voiceApi';

export type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** The OmniChat server and the device token (the app never talks to Aria directly). */
export const ctx = (): VoiceApiCtx => ({ base: getServerUrl(), token: getToken() ?? null });

/** User-facing error text; never contains the token. */
export function errText(tr: Tr, e: unknown): string {
  if (isVoiceOff(e)) return tr('host.set.off');
  if (isAriaUnreachable(e)) return tr('host.set.unreachable');
  if (isNotSupportedYet(e)) return tr('host.set.notSupported');
  if (e instanceof AriaHttpError) {
    if (e.status === 0) return tr('host.set.unreachable');
    if (e.status === 401 || e.status === 403) return tr('host.set.errAuth');
    return e.message && !/^HTTP \d+$/.test(e.message) ? e.message : tr('voice.voices.err.generic', { status: e.status });
  }
  return tr('host.set.unreachable');
}

/** Upload with progress (XMLHttpRequest exists on web and in React Native). The body is the file as-is. */
export function uploadWithProgress(url: string, token: string | null, body: Blob, onPct: (p: number) => void, abort: { current: (() => void) | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    if (token) x.setRequestHeader('Authorization', `Bearer ${token}`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.setRequestHeader('Accept', 'application/json');
    x.timeout = 10 * 60 * 1000;
    x.upload.onprogress = (ev) => { if (ev.lengthComputable && ev.total > 0) onPct(Math.min(100, Math.floor((ev.loaded / ev.total) * 100))); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let msg = '';
      let code: string | undefined;
      try {
        const j = JSON.parse(x.responseText);
        const m = j?.detail?.message ?? j?.detail ?? j?.error?.message ?? j?.error ?? j?.message;
        if (typeof m === 'string') msg = m.slice(0, 300);
        if (typeof j?.code === 'string') code = j.code;
      } catch { /* not JSON */ }
      reject(new AriaHttpError(x.status, msg || `HTTP ${x.status}`, code));
    };
    x.onerror = () => reject(new AriaHttpError(0, 'network'));
    x.ontimeout = () => reject(new AriaHttpError(0, 'timeout'));
    x.onabort = () => reject(new AriaHttpError(0, 'aborted'));
    abort.current = () => x.abort();
    x.send(body as any);
  });
}
