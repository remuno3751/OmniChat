/**
 * WS connection to the server bridge (docs/design/VSCODE-BRIDGE.md §2.1, §2.4, §2.5).
 * Connect -> send `ready` -> wait for `welcome` -> online. Reconnects with backoff.
 * The token only appears in the handshake URL and is never logged.
 */
import WebSocket, { type RawData } from "ws";
import { MAX_FRAME_BYTES, decode, encode } from "../protocol/codec";
import type { Frame, ReadyFrame, ToolName, WelcomeFrame, WorkspacesFrame } from "../protocol/frames";
import { PROTOCOL_VERSION, isCompatible } from "../protocol/version";

export type ClientStatus = "connecting" | "online" | "offline" | "incompatible" | "unauthorized" | "closed";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ClientOptions {
  /** Server base, ws:// or wss://. The path `/bridge` is appended unless already present. */
  url: string;
  token: string;
  name: string;
  instance: string;
  version: string;
  tools: ToolName[];
  workspaces: () => string[];
  /** Workspace Trust, read on each `ready`. Defaults to untrusted. */
  trusted?: () => boolean;
  onFrame: (frame: Frame) => void;
  /** Called for an accepted welcome, before the status goes "online". */
  onWelcome?: (frame: WelcomeFrame) => void;
  /** detail: reason (incompatible/unauthorized) or server version (online). */
  onStatus: (status: ClientStatus, detail?: string) => void;
  wsFactory?: (url: string) => WebSocket;
  timers?: Timers;
  /** Value in [0, 1); injected for deterministic jitter in tests. */
  random?: () => number;
}

export interface Client {
  /** Returns false (frame dropped) unless online. */
  send(frame: Frame): boolean;
  /** Sends the current workspaces as a `workspaces` frame. */
  sendWorkspaces(): boolean;
  /** Stops reconnecting and closes the socket. */
  close(): void;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const CLOSE_NORMAL = 1000;
const CLOSE_TOKEN_REVOKED = 4001;
const OPEN = 1;

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

function buildBridgeUrl(base: string, token: string, name: string, instance: string): string {
  const u = new URL(base);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error("bridge url must use ws:// or wss://");
  }
  const path = u.pathname.replace(/\/+$/, "");
  u.pathname = path.endsWith("/bridge") ? path : `${path}/bridge`;
  u.search = "";
  u.searchParams.set("token", token);
  u.searchParams.set("name", name);
  u.searchParams.set("kind", "vscode");
  u.searchParams.set("instance", instance);
  return u.toString();
}

/** Exponential backoff 1 s .. 30 s with +-25% jitter, clamped to that range. */
function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  const jittered = Math.round(base * (0.75 + 0.5 * random()));
  return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered));
}

function toText(data: RawData): string {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  return buf.toString("utf8");
}

export function createClient(opts: ClientOptions): Client {
  const timers = opts.timers ?? defaultTimers;
  const random = opts.random ?? Math.random;
  const makeSocket =
    opts.wsFactory ?? ((u: string) => new WebSocket(u, { maxPayload: MAX_FRAME_BYTES }));
  const url = buildBridgeUrl(opts.url, opts.token, opts.name, opts.instance);

  let sock: WebSocket | null = null;
  let online = false; // welcome accepted for the current socket
  let stopped = false; // no reconnects (closed, unauthorized, incompatible)
  let attempt = 0;
  let retryHandle: unknown = null;
  let pingHandle: unknown = null;
  let alive = false;

  const setStatus = (status: ClientStatus, detail?: string): void => {
    try {
      opts.onStatus(status, detail);
    } catch {
      // host callback errors must not break the connection
    }
  };

  // A throwing handler (bad data, host callback) must never escape into ws.
  const guard =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch {
        // ignored
      }
    };

  const readyFrame = (): ReadyFrame => {
    const workspaces = opts.workspaces();
    return {
      type: "ready",
      kind: "vscode",
      name: opts.name,
      instance: opts.instance,
      version: opts.version,
      protocol: PROTOCOL_VERSION,
      vscodeVersion: "unknown", // not in ClientOptions; host to supply later
      platform: process.platform,
      shell: "",
      remote: null,
      cwd: workspaces[0] ?? "",
      workspaces,
      allowAnyCwd: false,
      trusted: opts.trusted ? opts.trusted() : false,
      capabilities: {
        workspaces: true,
        fs: false,
        approval: true,
        checkpoints: true,
        transcript: true,
        chat: true,
        tools: [...opts.tools],
      },
    };
  };

  const stopPing = (): void => {
    if (pingHandle !== null) timers.clearInterval(pingHandle);
    pingHandle = null;
  };

  const startPing = (s: WebSocket): void => {
    stopPing();
    alive = true;
    pingHandle = timers.setInterval(() => {
      if (sock !== s) return;
      if (!alive) {
        s.terminate(); // missed pong: the close handler schedules the reconnect
        return;
      }
      alive = false;
      s.ping();
    }, PING_INTERVAL_MS);
  };

  const scheduleRetry = (): void => {
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    retryHandle = timers.setTimeout(() => {
      retryHandle = null;
      connect();
    }, delay);
  };

  const onWelcome = (s: WebSocket, f: WelcomeFrame): void => {
    // §2.5: extension older than the server's minimum -> reject, close, no reconnect.
    if (!isCompatible(f.minExtensionVersion, opts.version)) {
      stopped = true;
      online = false;
      sock = null; // detach first so the close event is ignored
      stopPing();
      setStatus(
        "incompatible",
        `VS Code extension ${opts.version} is outdated (need >= ${f.minExtensionVersion}). Update the .vsix.`,
      );
      s.close(CLOSE_NORMAL);
      return;
    }
    // §2.5: protocol mismatch -> keep the connection, never accept runs, no reconnect.
    if (f.protocol !== PROTOCOL_VERSION) {
      stopped = true;
      online = false;
      setStatus(
        "incompatible",
        `bridge protocol ${f.protocol} not supported (client speaks ${PROTOCOL_VERSION})`,
      );
      return;
    }
    online = true;
    attempt = 0; // a successful welcome resets the backoff
    try {
      opts.onWelcome?.(f);
    } catch {
      // host callback errors must not break the connection
    }
    setStatus("online", f.serverVersion);
  };

  const onMessage = (s: WebSocket, data: RawData): void => {
    const frame = decode(toText(data));
    if (!frame) return; // invalid, oversized, or unknown frame type
    if (frame.type === "welcome") {
      onWelcome(s, frame);
    } else if (online) {
      opts.onFrame(frame);
    }
  };

  const onClose = (s: WebSocket, code: number): void => {
    if (sock !== s) return;
    sock = null;
    online = false;
    stopPing();
    if (stopped) return;
    if (code === CLOSE_TOKEN_REVOKED) {
      stopped = true;
      setStatus("unauthorized", "token revoked");
      return;
    }
    setStatus("offline");
    scheduleRetry();
  };

  function connect(): void {
    if (stopped) return;
    setStatus("connecting");
    let s: WebSocket;
    try {
      s = makeSocket(url);
    } catch {
      setStatus("offline", "connect failed");
      scheduleRetry();
      return;
    }
    sock = s;
    s.on("open", guard(() => sock === s && onOpen(s)));
    s.on("message", guard((data: RawData) => sock === s && onMessage(s, data)));
    s.on("pong", () => {
      if (sock === s) alive = true;
    });
    // Required so ws does not throw on unhandled 'error'; the close event follows.
    s.on("error", () => undefined);
    s.on("close", guard((code: number) => onClose(s, code)));
  }

  const onOpen = (s: WebSocket): void => {
    startPing(s);
    s.send(encode(readyFrame())); // §2.1: ready once per connection
  };

  const send = (frame: Frame): boolean => {
    if (!sock || !online || sock.readyState !== OPEN) return false;
    try {
      sock.send(encode(frame));
      return true;
    } catch {
      return false;
    }
  };

  connect();

  return {
    send,
    sendWorkspaces() {
      const frame: WorkspacesFrame = {
        type: "workspaces",
        workspaces: opts.workspaces(),
        allowAnyCwd: false,
      };
      return send(frame);
    },
    close() {
      stopped = true;
      online = false;
      if (retryHandle !== null) timers.clearTimeout(retryHandle);
      retryHandle = null;
      stopPing();
      const s = sock;
      sock = null;
      if (s) {
        try {
          s.close(CLOSE_NORMAL);
        } catch {
          s.terminate();
        }
      }
      setStatus("closed");
    },
  };
}
