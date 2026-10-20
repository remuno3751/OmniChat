// Pure state machine for the "approve in DSH" pairing request (web only, no React).
// Opens the plugin loopback socket, sends a pairRequest hello and waits for the user to allow the
// request in DeepSeek Harness. Sockets, timers and the clock are injected; nothing runs at import time.
// The pairing token is handed to onApproved only; it never appears in status or errors.
import { localUrl, type WsFactory, type WsLike } from './dshRelay';

export type PairRequestState = 'idle' | 'connecting' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';
export type PairRequestError = 'origin' | 'locked' | 'busy' | 'unreachable' | 'invalid' | 'unknown';

export interface PairRequestStatus {
  state: PairRequestState;
  /** ms epoch when the request expires (pending only) */
  expiresAt?: number;
  error?: PairRequestError;
}

export interface PairRequestTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface PairRequestOptions {
  port: number;
  clientName: string;
  wsFactory: WsFactory;
  timers?: PairRequestTimers;
  now?: () => number;
  helloTimeoutMs?: number;
  onChange: (s: PairRequestStatus) => void;
  onApproved: (token: string) => void;
}

const WS_OPEN = 1;
const DEFAULT_HELLO_TIMEOUT_MS = 10000;
const EXPIRY_GRACE_MS = 5000;
const TOKEN_MAX = 200;

function defaultTimers(): PairRequestTimers {
  const g: any = globalThis;
  return {
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (h) => g.clearTimeout(h),
  };
}

function has(h: unknown): boolean {
  return h !== null && h !== undefined;
}

/** Close code -> failure status, used when the socket closes before a terminal frame. */
function closeOutcome(code: number | undefined): { state: PairRequestState; error?: PairRequestError } {
  switch (code) {
    case 4403:
      return { state: 'error', error: 'origin' };
    case 4429:
      return { state: 'error', error: 'locked' };
    case 4003:
      return { state: 'error', error: 'busy' };
    case 4002:
      return { state: 'denied' };
    default:
      return { state: 'error', error: 'unreachable' };
  }
}

export class DshPairRequest {
  private readonly opts: PairRequestOptions;
  private readonly timers: PairRequestTimers;
  private readonly now: () => number;
  private readonly helloTimeout: number;

  private status: PairRequestStatus = { state: 'idle' };
  private ws: WsLike | null = null;
  private started = false;
  private helloTimer: unknown = null;
  private expiryTimer: unknown = null;

  constructor(o: PairRequestOptions) {
    this.opts = o;
    this.timers = o.timers ?? defaultTimers();
    this.now = o.now ?? (() => Date.now());
    this.helloTimeout = o.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  /** Opens the socket once. A second call is a no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setStatus({ state: 'connecting' });
    this.helloTimer = this.later(() => {
      this.helloTimer = null;
      this.finish('error', 'unreachable');
    }, this.helloTimeout);
    let ws: WsLike;
    try {
      ws = this.opts.wsFactory(localUrl(this.opts.port));
    } catch {
      this.finish('error', 'unreachable');
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => this.guard(() => this.onOpen(ws)));
    ws.addEventListener('message', (ev: any) => this.guard(() => this.onMessage(ws, ev?.data)));
    ws.addEventListener('close', (ev: any) => this.guard(() => this.onClose(ws, ev?.code)));
    ws.addEventListener('error', () => this.guard(() => this.onError(ws)));
  }

  getStatus(): PairRequestStatus {
    return { ...this.status };
  }

  /** Closes the socket and returns to idle. No callbacks are called after this. */
  cancel(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.status = { state: 'idle' };
    if (ws) this.safeClose(ws, 1000);
  }

  // ---- socket events ------------------------------------------------------

  private onOpen(ws: WsLike): void {
    if (ws !== this.ws || this.status.state !== 'connecting') return;
    const hello = {
      type: 'hello',
      client: 'omnichat-app',
      version: 'app',
      pairRequest: true,
      clientName: this.opts.clientName,
    };
    this.safeSend(ws, JSON.stringify(hello));
  }

  private onMessage(ws: WsLike, data: unknown): void {
    if (ws !== this.ws || typeof data !== 'string') return;
    const state = this.status.state;
    if (state !== 'connecting' && state !== 'pending') return;
    let frame: any = null;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if (frame.type === 'pair-pending') {
      if (state !== 'connecting') return;
      const sec = frame.expiresInSec;
      if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
        this.finish('error', 'invalid');
        return;
      }
      this.clear(this.helloTimer);
      this.helloTimer = null;
      const expiresAt = this.now() + sec * 1000;
      this.setStatus({ state: 'pending', expiresAt });
      this.clear(this.expiryTimer);
      this.expiryTimer = this.later(() => {
        this.expiryTimer = null;
        this.finish('expired');
      }, sec * 1000 + EXPIRY_GRACE_MS);
      return;
    }

    if (frame.type === 'pair-approved') {
      const token = frame.pairing;
      if (typeof token !== 'string' || token.trim() === '' || token.trim().length > TOKEN_MAX) {
        this.finish('error', 'invalid');
        return;
      }
      const clean = token.trim();
      this.finish('approved');
      this.callApproved(clean);
      return;
    }

    if (frame.type === 'pair-denied') {
      this.finish(frame.reason === 'expired' ? 'expired' : 'denied');
    }
  }

  private onClose(ws: WsLike, code: unknown): void {
    if (ws !== this.ws) return;
    const c = typeof code === 'number' ? code : undefined;
    const out = closeOutcome(c);
    this.finish(out.state, out.error);
  }

  private onError(ws: WsLike): void {
    if (ws !== this.ws) return;
    this.finish('error', 'unreachable');
  }

  // ---- state helpers ------------------------------------------------------

  /** Moves to a terminal (or connecting/pending) state, closing the socket for terminal states. */
  private finish(state: PairRequestState, error?: PairRequestError): void {
    if (this.isTerminal()) return;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    const s: PairRequestStatus = { state };
    if (error !== undefined) s.error = error;
    this.status = s;
    if (ws) this.safeClose(ws, 1000);
    this.emit();
  }

  private isTerminal(): boolean {
    const s = this.status.state;
    return s === 'approved' || s === 'denied' || s === 'expired' || s === 'error' || s === 'idle';
  }

  private setStatus(s: PairRequestStatus): void {
    this.status = s;
    this.emit();
  }

  private callApproved(token: string): void {
    try {
      this.opts.onApproved(token);
    } catch {
      /* the callback owns its own errors */
    }
  }

  private emit(): void {
    try {
      this.opts.onChange(this.getStatus());
    } catch {
      /* onChange errors are swallowed */
    }
  }

  private clearTimers(): void {
    this.clear(this.helloTimer);
    this.helloTimer = null;
    this.clear(this.expiryTimer);
    this.expiryTimer = null;
  }

  // ---- helpers ------------------------------------------------------------

  private later(fn: () => void, ms: number): unknown {
    return this.timers.setTimeout(() => this.guard(fn), ms);
  }

  private clear(h: unknown): void {
    if (!has(h)) return;
    try {
      this.timers.clearTimeout(h);
    } catch {
      /* ignore */
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      /* handlers never throw out */
    }
  }

  private safeSend(ws: WsLike, data: string): void {
    try {
      if (ws.readyState === WS_OPEN) ws.send(data);
    } catch {
      /* the close event reports the failure */
    }
  }

  // Browsers only accept 1000 and 3000-4999 in close(); fall back to a plain close.
  private safeClose(ws: WsLike, code?: number): void {
    try {
      if (code !== undefined) ws.close(code);
      else ws.close();
    } catch {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
