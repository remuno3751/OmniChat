/**
 * Call diagnosis (docs/design/ARIA-HOST-ADDENDUM.md, item 6). Pure: no React / native imports. The browser and
 * timer parts are injected, so the node tests can run the probe with fakes.
 * Rows never carry the relay URL or the token: messages are fixed texts (or the server's own check messages).
 */
import type { DiagnoseItem } from './voiceApi';

export type DiagLevel = 'ok' | 'ng' | 'skip';
export interface DiagRow { id: string; level: DiagLevel; message: string; hint?: string }
export type Tr = (key: string, vars?: Record<string, string | number>) => string;

export const OPEN_TIMEOUT_MS = 5000;
export const READY_TIMEOUT_MS = 8000;

/** Microphone check result: 'skipped' where the check is not done on the device (native). */
export type MicState = 'granted' | 'denied' | 'missing' | 'failed' | 'skipped';

/** Result of one WebSocket probe. */
export interface ProbeResult {
  opened: boolean;
  /** ms from the start of the connect until the `ready` message */
  readyMs?: number;
  error?: 'open-timeout' | 'open-error' | 'ready-timeout' | 'closed';
  closeCode?: number;
}

/** The part of WebSocket the probe uses (the browser's and React Native's both fit). */
export interface SocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  close(): void;
}
export interface ProbeDeps {
  WebSocketImpl: new (url: string) => SocketLike;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

/** Server-side checks (GET /voice/diagnose): the server's own ok flag and message, shown as they are. */
export function serverRows(items: DiagnoseItem[]): DiagRow[] {
  return items.map((it) => ({ id: `srv.${it.id}`, level: it.ok ? 'ok' : 'ng', message: it.message, ...(it.hint ? { hint: it.hint } : {}) }));
}

/** A getUserMedia error name -> the microphone state. Permission errors are 'denied'; no device is 'missing'. */
export function micErrorState(name: string | undefined): MicState {
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  return 'failed';
}

export function micRow(state: MicState, tr: Tr): DiagRow {
  switch (state) {
    case 'granted': return { id: 'mic', level: 'ok', message: tr('host.diag.mic.ok') };
    case 'denied': return { id: 'mic', level: 'ng', message: tr('host.diag.mic.denied'), hint: tr('host.diag.mic.deniedHint') };
    case 'missing': return { id: 'mic', level: 'ng', message: tr('host.diag.mic.missing'), hint: tr('host.diag.mic.missingHint') };
    case 'failed': return { id: 'mic', level: 'ng', message: tr('host.diag.mic.failed'), hint: tr('host.diag.mic.failedHint') };
    default: return { id: 'mic', level: 'skip', message: tr('host.diag.mic.skipped') };
  }
}

/** The relay URL with `private=1` (no conversation is created or saved). An existing `private=` is replaced. */
export function withPrivate(url: string): string {
  const base = url.replace(/([?&])private=[^&#]*&?/, '$1').replace(/[?&]$/, '');
  return `${base}${base.includes('?') ? '&' : '?'}private=1`;
}

/**
 * Opens the relay with `private=1`, waits for the `ready` message, then closes. Gives up when the socket does not
 * open within OPEN_TIMEOUT_MS, or when `ready` does not come within READY_TIMEOUT_MS after the open. Sends nothing.
 */
export function probeRelay(url: string, deps: ProbeDeps): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const t0 = deps.now();
    let opened = false;
    let done = false;
    let timer: unknown;
    let ws: SocketLike;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      deps.cancel(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(r);
    };
    const arm = (fn: () => void, ms: number) => { deps.cancel(timer); timer = deps.schedule(fn, ms); };
    try {
      ws = new deps.WebSocketImpl(url);
    } catch {
      resolve({ opened: false, error: 'open-error' });
      return;
    }
    arm(() => finish({ opened: false, error: 'open-timeout' }), OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      arm(() => finish({ opened: true, error: 'ready-timeout' }), READY_TIMEOUT_MS);
    };
    ws.onmessage = (ev) => {
      let type: unknown;
      try { type = typeof ev.data === 'string' ? (JSON.parse(ev.data) as { type?: unknown }).type : undefined; } catch { type = undefined; }
      if (type === 'ready') finish({ opened: true, readyMs: Math.max(0, deps.now() - t0) });
    };
    ws.onerror = () => finish({ opened, error: opened ? 'closed' : 'open-error' });
    ws.onclose = (ev) => finish({ opened, error: opened ? 'closed' : 'open-error', closeCode: typeof ev?.code === 'number' ? ev.code : undefined });
  });
}

/** Rows for a probe result. 4409 = voice off, 4429 = busy (another call is running). */
export function wsRows(r: ProbeResult, tr: Tr): DiagRow[] {
  let ws: DiagRow;
  if (r.opened) ws = { id: 'ws', level: 'ok', message: tr('host.diag.ws.ok') };
  else if (r.error === 'open-timeout') ws = { id: 'ws', level: 'ng', message: tr('host.diag.ws.timeout'), hint: tr('host.diag.ws.hint') };
  else if (r.closeCode === 4409) ws = { id: 'ws', level: 'ng', message: tr('host.set.off') };
  else if (r.closeCode === 4429) ws = { id: 'ws', level: 'ng', message: tr('host.diag.ws.busy') };
  else ws = { id: 'ws', level: 'ng', message: tr('host.diag.ws.fail'), hint: tr('host.diag.ws.hint') };

  let ready: DiagRow;
  if (r.readyMs !== undefined) ready = { id: 'ready', level: 'ok', message: tr('host.diag.ready.ok', { ms: Math.round(r.readyMs) }) };
  else if (r.opened) ready = { id: 'ready', level: 'ng', message: tr('host.diag.ready.timeout'), hint: tr('host.diag.ready.hint') };
  else ready = { id: 'ready', level: 'skip', message: tr('host.diag.ready.skip') };
  return [ws, ready];
}

export interface DiagDeps {
  server: () => Promise<DiagnoseItem[]>;
  mic: () => Promise<MicState>;
  /** the relay URL (without `private`), or null when there is no server address or sign-in */
  relayUrl: string | null;
  probe: (url: string) => Promise<ProbeResult>;
}

/**
 * Runs the server checks, the microphone check and the relay probe. One failing check gives its own 'ng' row and
 * does not stop the others.
 */
export async function runDiagnose(deps: DiagDeps, tr: Tr): Promise<DiagRow[]> {
  const server = deps.server().then(serverRows, (): DiagRow[] => [{ id: 'srv', level: 'ng', message: tr('host.diag.server.fail') }]);
  const mic = deps.mic().catch((): MicState => 'failed').then((st) => [micRow(st, tr)]);
  const ws: Promise<DiagRow[]> = !deps.relayUrl
    ? Promise.resolve([{ id: 'ws', level: 'ng' as const, message: tr('host.diag.ws.noUrl') }])
    : deps.probe(withPrivate(deps.relayUrl)).then((r) => wsRows(r, tr), (): DiagRow[] => [{ id: 'ws', level: 'ng', message: tr('host.diag.ws.fail') }]);
  const [s, m, w] = await Promise.all([server, mic, ws]);
  return [...s, ...m, ...w];
}
