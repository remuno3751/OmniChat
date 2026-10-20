// WebSocket stand-in for the desktop app (web): the OmniChat page is served by the server, so the DSH plugin sees the server's Origin and
// refuses a pairing request. This factory opens the socket inside a hidden frame of the app's own origin (desktop/launcher/dsh-bridge-frame.js),
// which the plugin does accept, and relays the events over postMessage. Nothing runs at import time.
import type { WsFactory, WsLike } from './dshRelay';

export interface FrameHost {
  /** posts to the frame once it is loaded (queued until then) */
  post(msg: unknown): void
  /** subscribes to messages coming from the frame */
  onMessage(fn: (msg: any) => void): void
}

/** The proxy sockets share one frame. `host` is injected so the logic runs without a DOM. */
export function frameWsFactory(host: FrameHost): WsFactory {
  const socks = new Map<string, FrameWs>();
  let seq = 0;
  let wired = false;
  const wire = () => {
    if (wired) return;
    wired = true;
    host.onMessage((m) => {
      if (!m || m.t !== 'ev' || typeof m.id !== 'string') return;
      socks.get(m.id)?.deliver(m);
    });
  };
  return (url: string): WsLike => {
    wire();
    const id = `s${++seq}`;
    const ws = new FrameWs(id, (msg) => host.post(msg), () => socks.delete(id));
    socks.set(id, ws);
    host.post({ t: 'open', id, url });
    return ws;
  };
}

class FrameWs implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  private fns: Record<string, Array<(ev: any) => void>> = { open: [], message: [], close: [], error: [] };

  constructor(private id: string, private post: (m: unknown) => void, private done: () => void) {}

  send(data: string): void {
    this.post({ t: 'send', id: this.id, data });
  }

  close(code?: number): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.post({ t: 'close', id: this.id, code });
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void {
    this.fns[type]?.push(fn);
  }

  deliver(m: { kind: string; data?: unknown; code?: unknown }): void {
    if (m.kind === 'open') this.readyState = 1;
    else if (m.kind === 'close') { this.readyState = 3; this.done(); }
    const ev = m.kind === 'message' ? { data: m.data } : m.kind === 'close' ? { code: m.code } : {};
    for (const f of this.fns[m.kind] ?? []) f(ev);
  }
}

/** A frame host backed by a real hidden iframe. Web only. */
export function iframeHost(frameUrl: string): FrameHost {
  const doc: any = (globalThis as any).document;
  const win: any = (globalThis as any).window;
  const frameOrigin = new URL(frameUrl).origin;
  let frame: any = null;
  let loaded = false;
  const queue: unknown[] = [];
  const listeners: Array<(m: any) => void> = [];
  const ensure = () => {
    if (frame) return;
    frame = doc.createElement('iframe');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.addEventListener('load', () => { loaded = true; for (const q of queue.splice(0)) frame.contentWindow.postMessage(q, frameOrigin); });
    frame.src = frameUrl;
    doc.body.appendChild(frame);
    win.addEventListener('message', (ev: any) => {
      if (ev.source !== frame?.contentWindow || ev.origin !== frameOrigin) return;
      for (const f of listeners) f(ev.data);
    });
  };
  return {
    post(msg) {
      ensure();
      if (loaded) frame.contentWindow.postMessage(msg, frameOrigin);
      else queue.push(msg);
    },
    onMessage(fn) { listeners.push(fn); },
  };
}

/** The frame URL the desktop shell reports (window.__OMNICHAT_DESKTOP__.dshFrame), when this page needs it: not for a page of the shell's own origin. */
export function desktopDshFrameUrl(w: any): string | null {
  const url = w?.__OMNICHAT_DESKTOP__?.dshFrame;
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.pathname !== '/dsh-bridge-frame.html') return null;
    if (w?.location?.origin === u.origin) return null; // already the shell's own origin: a direct socket works
    return url;
  } catch {
    return null;
  }
}
