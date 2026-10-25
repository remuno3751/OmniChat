/* VS Code extension bridge: transport (docs/design/VSCODE-BRIDGE.md S2-S4, S11).
   One WebSocket per VS Code window (instance), pooled per (user, bridge name). The agent loop (code-agent.ts) opens a run on the
   instance that has the chosen cwd, calls tools, and closes the run. Approval wiring (S8) and checkpoint/changes storage (S9)
   plug in through VscodeRunHooks, so this module knows nothing about the database. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isValidCwd, normCwd } from "./cwd.js";

/** Oldest extension version this server accepts runs from (returned in `welcome`). Raise it when the wire changes. */
export const VSCODE_EXT_MIN_VERSION = "0.1.0";
/** Wire protocol number (`ready.protocol` must match, else the connection stays but runs are refused). */
export const VSCODE_PROTOCOL = 1;
/** Late frames (changes/checkpoint/approval) of a finished run are still accepted this long (spec 2.4). */
export const VSCODE_RECENT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const RUN_COMMAND_DEFAULT_MS = 120_000;
const RUN_COMMAND_GRACE_MS = 10_000;
const ACK_TIMEOUT_MS = 15_000;
const DONE_TIMEOUT_MS = 30_000;

export type VscodeErrorCode =
  | "offline" | "workspace_not_open" | "busy" | "outdated" | "protocol" | "untrusted_workspace"
  | "cwd_not_allowed" | "no_ack" | "disconnected" | "closed" | "aborted";

export class VscodeBridgeError extends Error {
  constructor(public readonly code: VscodeErrorCode, message: string) { super(message); }
}

/* ---------- types ---------- */

export interface ToolApproval { by: string; protectedOk: boolean; outsideOk?: boolean }
export type ToolResult =
  | { ok: true; result: unknown; truncated: boolean; durationMs: number }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** A frame of the extension, as received (already JSON-parsed; unknown fields kept). */
export type RawFrame = { type: string; [k: string]: any };

export interface VscodeRunHooks {
  /** `checkpoint` frame (requestId = runId); may arrive before the run is acknowledged and, rarely, after `done` (recent window) */
  onCheckpoint?(frame: RawFrame): void;
  /** `changes` frame (before `done`, or within the recent window) */
  onChanges?(frame: RawFrame): void;
  /** extension-originated `approval`; the reply is sent back as `approval_reply`. No hook / a throw = "rejected". */
  onApproval?(frame: RawFrame): Promise<"allowed-once" | "rejected">;
  /** `approval_decision` from the VS Code approval panel (P3, S8) */
  onApprovalDecision?(frame: RawFrame): void;
  /** tool_progress events of a call */
  onProgress?(callId: string, stream: "stdout" | "stderr", text: string): void;
}

export interface VscodeReady {
  version: string; protocol: number; vscodeVersion: string; platform: string; shell: string;
  remote: string | null; cwd: string; workspaces: string[]; allowAnyCwd: boolean; trusted: boolean;
  tools: string[]; capabilities: { workspaces: boolean; fs: boolean; approval: boolean; checkpoints: boolean; transcript: boolean; chat: boolean; transcriptDelta: boolean };
}

export interface DoneInfo { ok: boolean; error?: string; warning?: string }

interface PendingCall {
  callId: string; tool: string; timeoutMs: number; timer: NodeJS.Timeout | null; startedAt: number; remaining: number;
  paused: number; resolve(r: ToolResult): void; reject(e: Error): void;
}
interface ActiveRun {
  runId: string; hooks: VscodeRunHooks; calls: Map<string, PendingCall>;
  ack: { resolve(): void; reject(e: Error): void; timer: NodeJS.Timeout } | null;
  done: Promise<DoneInfo>; settleDone(d: DoneInfo): void; ended: boolean; cancelled: boolean;
}
interface Conn {
  deviceId: string; userId: string; name: string; instance: string; ws: WebSocket; alive: boolean;
  ready: VscodeReady | null; run: ActiveRun | null; recent: Map<string, VscodeRunHooks>;
  /** chat frame rate limit (S12) */
  rl: { start: number; n: number; warned: number };
}

const conns = new Map<string, Conn>(); // userId \0 name \0 instance
const connKey = (userId: string, name: string, instance: string) => `${userId}\u0000${name}\u0000${instance}`;
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

/* ---------- version helpers (S11) ---------- */

/** Compares the numeric core of two semver strings (pre-release tags are ignored). Unparsable = lowest. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const x = p(a), y = p(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export const extensionCompatOk = (version: string, min = VSCODE_EXT_MIN_VERSION): boolean => compareVersions(version, min) >= 0;
export const outdatedMessage = (version: string, min = VSCODE_EXT_MIN_VERSION): string =>
  `VS Code extension ${version || "(unknown)"} is outdated (need >= ${min}). Update the .vsix.`;

let cachedServerVersion: string | null = null;
function serverVersion(): string {
  if (cachedServerVersion) return cachedServerVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    cachedServerVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { cachedServerVersion = "0.0.0"; }
  return cachedServerVersion!;
}

/* ---------- parsing ---------- */

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
function sanitizeWorkspaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (!isValidCwd(w) || seen.has(normCwd(w))) continue;
    seen.add(normCwd(w));
    out.push(w);
    if (out.length >= 50) break;
  }
  return out;
}
function parseReady(m: any): VscodeReady {
  const caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
  const tools = Array.isArray(caps.tools) ? caps.tools.filter((t: unknown): t is string => typeof t === "string" && t.length > 0 && t.length <= 40).slice(0, 50) : [];
  return {
    version: clip(m.version, 40), protocol: Number.isInteger(m.protocol) ? m.protocol : 0, vscodeVersion: clip(m.vscodeVersion, 40),
    platform: clip(m.platform, 40), shell: clip(m.shell, 100), remote: typeof m.remote === "string" && m.remote ? clip(m.remote, 40) : null,
    cwd: isValidCwd(m.cwd) ? m.cwd : "", workspaces: sanitizeWorkspaces(m.workspaces), allowAnyCwd: m.allowAnyCwd === true, trusted: m.trusted !== false,
    tools,
    capabilities: { workspaces: caps.workspaces === true, fs: caps.fs === true, approval: caps.approval === true, checkpoints: caps.checkpoints === true, transcript: caps.transcript === true, chat: caps.chat === true, transcriptDelta: caps.transcriptDelta === true },
  };
}

/* ---------- connection ---------- */

const send = (c: Conn, o: unknown): boolean => {
  if (c.ws.readyState !== c.ws.OPEN) return false;
  try { c.ws.send(JSON.stringify(o)); return true; } catch { return false; }
};

function newRun(runId: string, hooks: VscodeRunHooks): ActiveRun {
  let settle!: (d: DoneInfo) => void;
  const done = new Promise<DoneInfo>((res) => { settle = res; });
  return { runId, hooks, calls: new Map(), ack: null, done, settleDone: settle, ended: false, cancelled: false };
}

function clearCall(call: PendingCall) { if (call.timer) { clearTimeout(call.timer); call.timer = null; } }

/** Ends the run's bookkeeping: pending calls fail/resolve, the instance becomes free, the hooks stay reachable for the recent window. */
function finishRun(c: Conn, run: ActiveRun, done: DoneInfo, failCalls?: Error): void {
  if (run.ended) return;
  run.ended = true;
  if (run.ack) { clearTimeout(run.ack.timer); const a = run.ack; run.ack = null; a.reject(failCalls ?? new VscodeBridgeError("closed", "Run ended")); }
  for (const call of [...run.calls.values()]) {
    clearCall(call);
    run.calls.delete(call.callId);
    if (failCalls) call.reject(failCalls);
    else call.resolve({ ok: false, error: { code: "cancelled", message: "Run ended" } });
  }
  if (c.run === run) c.run = null;
  c.recent.set(run.runId, run.hooks);
  setTimeout(() => c.recent.delete(run.runId), VSCODE_RECENT_MS).unref();
  run.settleDone(done);
}

function dropConn(c: Conn, reason: string): void {
  const k = connKey(c.userId, c.name, c.instance);
  if (conns.get(k) === c) conns.delete(k);
  if (c.run) finishRun(c, c.run, { ok: false, error: reason }, new VscodeBridgeError("disconnected", reason));
  for (const id of [...rewinds.keys()]) settleRewind(id, c, { ok: false, error: "bridge disconnected" });
}

function onMessage(c: Conn, raw: string): void {
  let m: RawFrame;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return;
  try {
    if (m.type === "ready") {
      c.ready = parseReady(m);
      send(c, { type: "welcome", protocol: VSCODE_PROTOCOL, serverVersion: serverVersion(), minExtensionVersion: VSCODE_EXT_MIN_VERSION, features: ["chat"] });
      return;
    }
    if (!c.ready) return; // frames before `ready` are ignored
    if (CHAT_FRAME_TYPES.has(m.type)) { onChatFrame(c, m); return; }
    const reqId = typeof m.requestId === "string" ? m.requestId : typeof m.runId === "string" ? m.runId : "";
    const hooksFor = (id: string): VscodeRunHooks | undefined => (c.run && c.run.runId === id ? c.run.hooks : c.recent.get(id));
    switch (m.type) {
      case "workspaces":
        c.ready.workspaces = sanitizeWorkspaces(m.workspaces);
        if ("allowAnyCwd" in m) c.ready.allowAnyCwd = m.allowAnyCwd === true;
        return;
      case "run_ack": {
        const run = c.run;
        if (!run || run.runId !== m.runId || !run.ack) return;
        clearTimeout(run.ack.timer);
        const a = run.ack; run.ack = null;
        if (m.ok === true) a.resolve();
        else {
          const e = clip(m.error, 200);
          a.reject(e === "busy" ? new VscodeBridgeError("busy", "VS Code window is busy with another run")
            : e === "untrusted_workspace" ? new VscodeBridgeError("untrusted_workspace", "The VS Code workspace is not trusted (Workspace Trust). Trust it to let the agent run.")
            : new VscodeBridgeError("cwd_not_allowed", e === "cwd not allowed" ? "The VS Code extension does not allow this folder" : e || "Run refused by the VS Code extension"));
          if (c.run === run) { c.run = null; run.ended = true; run.settleDone({ ok: false, error: e || "refused" }); }
        }
        return;
      }
      case "checkpoint": hooksFor(reqId)?.onCheckpoint?.(m); return;
      case "changes": hooksFor(reqId)?.onChanges?.(m); return;
      case "approval_decision": {
        // approval ids are global; any live or recent run may own it
        const h = c.run?.hooks ?? [...c.recent.values()].pop();
        h?.onApprovalDecision?.(m);
        return;
      }
      case "event": {
        const run = c.run;
        const ev = m.event;
        if (!run || run.runId !== m.runId || !ev || ev.type !== "tool_progress") return;
        if (!run.calls.has(String(ev.callId))) return;
        run.hooks.onProgress?.(String(ev.callId), ev.stream === "stderr" ? "stderr" : "stdout", clip(ev.text, 70_000));
        return;
      }
      case "tool_result": {
        const run = c.run;
        if (!run || run.runId !== m.runId) return; // late / foreign result: dropped
        const call = run.calls.get(String(m.callId));
        if (!call) return; // already timed out or cancelled: dropped
        clearCall(call);
        run.calls.delete(call.callId);
        if (m.ok === true) call.resolve({ ok: true, result: m.result, truncated: m.truncated === true, durationMs: Number.isFinite(m.durationMs) ? m.durationMs : 0 });
        else {
          const e = m.error && typeof m.error === "object" ? m.error : {};
          call.resolve({ ok: false, error: { code: clip(e.code, 40) || "internal", message: clip(e.message, 4000) || "tool failed", ...(e.details !== undefined ? { details: e.details } : {}) } });
        }
        return;
      }
      case "approval": {
        const run = c.run;
        const hooks = hooksFor(reqId);
        const approvalId = clip(m.approvalId, 200);
        if (!approvalId) return;
        const call = run && typeof m.callId === "string" ? run.calls.get(m.callId) : undefined;
        if (call) pauseCall(call);
        const reply = (decision: "allowed-once" | "rejected") => {
          if (call && run && run.calls.get(call.callId) === call) resumeCall(c, run, call);
          send(c, { type: "approval_reply", approvalId, decision });
        };
        if (!hooks?.onApproval) { reply("rejected"); return; }
        hooks.onApproval(m).then((d) => reply(d === "allowed-once" ? "allowed-once" : "rejected"), () => reply("rejected"));
        return;
      }
      case "done": {
        const run = c.run;
        if (!run || run.runId !== m.runId) return;
        finishRun(c, run, { ok: m.ok === true, ...(m.error ? { error: clip(m.error, 2000) } : {}), ...(m.warning ? { warning: clip(m.warning, 500) } : {}) });
        return;
      }
      case "rewound": {
        if (typeof m.requestId === "string") settleRewind(m.requestId, c, m.ok === true ? { ok: true } : { ok: false, error: clip(m.error, 2000) || "rewind failed" });
        return;
      }
    }
  } catch {
    /* a malformed frame must not take the server down */
  }
}

/* ---------- chat from VS Code (S12): frames are handed to vscode-chat.ts ---------- */

const CHAT_FRAME_TYPES = new Set(["prompt", "models_request", "conversations_request", "conversation_request", "set_approval_mode", "stop", "context_request", "devices_request", "compact_request", "conversation_settings_request", "conversation_settings_set", "history_search_request", "checkpoints_request", "checkpoint_restore"]);
/** Chat frames per second and connection; more are dropped with an `error` frame. */
export const VSCODE_CHAT_RATE = 30;

/** The extension side of one connection, as the chat handler sees it. */
export interface VscodeChatPeer {
  userId: string; bridge: string; instance: string; cwd: string; workspaces: string[];
  /** sends a frame to this instance only */
  reply(frame: unknown): boolean;
}
export type VscodeChatHandler = (peer: VscodeChatPeer, frame: RawFrame) => void;
let chatHandler: VscodeChatHandler | null = null;
/** vscode-chat.ts registers itself here (keeps this module free of chat / database imports). */
export function setVscodeChatHandler(h: VscodeChatHandler | null): void { chatHandler = h; }

/** The instance advertises both `chat` and `transcript`. */
const chatCapable = (c: Conn): boolean => !!c.ready && c.ready.capabilities.chat && c.ready.capabilities.transcript && c.ws.readyState === c.ws.OPEN;

function onChatFrame(c: Conn, m: RawFrame): void {
  if (!chatHandler || !chatCapable(c)) return;
  const now = Date.now();
  if (now - c.rl.start >= 1000) { c.rl.start = now; c.rl.n = 0; }
  if (++c.rl.n > VSCODE_CHAT_RATE) {
    if (now - c.rl.warned >= 1000) {
      c.rl.warned = now;
      send(c, { type: "error", code: "rate_limited", message: "Too many chat frames", ...(typeof m.requestId === "string" ? { requestId: m.requestId.slice(0, 100) } : {}) });
    }
    return;
  }
  const peer: VscodeChatPeer = { userId: c.userId, bridge: c.name, instance: c.instance, cwd: c.ready!.cwd, workspaces: c.ready!.workspaces, reply: (f) => send(c, f) };
  try { chatHandler(peer, m); } catch { /* a bad chat frame must not take the connection down */ }
}

/** Sends a frame to every chat-capable instance of the user's bridge `name`. Returns how many received it. */
export function sendToChatInstances(userId: string, name: string, frame: unknown): number {
  let n = 0;
  for (const c of conns.values()) if (c.userId === userId && c.name === name && chatCapable(c) && send(c, frame)) n++;
  return n;
}

/** Like sendToChatInstances, but the frame is built per instance from what it advertised (`transcriptDelta`, v0.5.5-a). */
export function sendToChatInstancesBy(userId: string, name: string, build: (caps: { transcriptDelta: boolean }) => unknown): number {
  let n = 0;
  for (const c of conns.values()) {
    if (c.userId !== userId || c.name !== name || !chatCapable(c)) continue;
    if (send(c, build({ transcriptDelta: c.ready!.capabilities.transcriptDelta }))) n++;
  }
  return n;
}

/** Throws the VscodeBridgeError openRun would throw (workspace_not_open, busy, outdated, protocol, untrusted_workspace, offline). Starts nothing. */
export function checkRunnable(userId: string, bridge: string, cwd: string): void { pickInstance(userId, bridge, cwd); }

/* ---------- call timers (approval waits do not count) ---------- */

function armCall(c: Conn, run: ActiveRun, call: PendingCall, ms: number): void {
  clearCall(call);
  call.startedAt = Date.now();
  call.remaining = ms;
  call.timer = setTimeout(() => {
    if (run.calls.get(call.callId) !== call) return;
    run.calls.delete(call.callId);
    call.timer = null;
    call.resolve({ ok: false, error: { code: "timeout", message: `Tool call '${call.tool}' timed out after ${call.timeoutMs} ms` } });
  }, ms);
  call.timer.unref?.();
}
function pauseCall(call: PendingCall): void {
  if (call.paused++ > 0) return;
  if (call.timer) { call.remaining = Math.max(1, call.remaining - (Date.now() - call.startedAt)); clearCall(call); }
}
function resumeCall(c: Conn, run: ActiveRun, call: PendingCall): void {
  if (--call.paused > 0) return;
  call.paused = 0;
  armCall(c, run, call, call.remaining);
}

/* ---------- WebSocket upgrade ---------- */

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const isValidInstance = (v: unknown): v is string => typeof v === "string" && INSTANCE_RE.test(v);

/** Called by bridges.ts for `kind=vscode` after the token check. `name` is already trimmed and non-empty. */
export function handleVscodeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, user: { userId: string; deviceId: string }, name: string, instance: string): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const k = connKey(user.userId, name, instance);
    const old = conns.get(k);
    const c: Conn = { deviceId: user.deviceId, userId: user.userId, name, instance, ws, alive: true, ready: null, run: null, recent: new Map(), rl: { start: 0, n: 0, warned: 0 } };
    if (old) {
      dropConn(old, `Bridge '${name}' was replaced by a new connection`);
      try { old.ws.close(4000, "replaced"); } catch { /* ignore */ }
    }
    conns.set(k, c);
    const timer = setInterval(() => {
      if (!c.alive) { ws.terminate(); return; }
      c.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 20000);
    timer.unref();
    ws.on("pong", () => { c.alive = true; });
    ws.on("message", (raw) => { c.alive = true; onMessage(c, raw.toString()); });
    const gone = () => { clearInterval(timer); dropConn(c, `Bridge '${name}' disconnected during the run`); };
    ws.on("close", gone);
    ws.on("error", gone);
  });
}

/** Close the vscode sockets of a revoked device (code 4001). */
export function closeVscodeDeviceBridges(userId: string, deviceId: string): void {
  for (const c of [...conns.values()]) {
    if (c.userId === userId && c.deviceId === deviceId) { try { c.ws.close(4001, "device revoked"); } catch { /* ignore */ } }
  }
}

/* ---------- listing (S3) ---------- */

export interface VscodeBridgeInfo {
  name: string; kind: "vscode"; cwd: string; online: true;
  version: string; protocol: number; tools: string[]; trusted: boolean; busy: boolean;
  compat: { ok: boolean; minVersion: string };
  workspacesSupported: true; workspaces: string[]; allowAnyCwd: boolean; instances: number; remote: string | null;
}

/** Ready vscode connections of a user, one entry per bridge name (workspaces = union, version = the oldest, compat = all). */
export function listVscodeBridges(userId: string): VscodeBridgeInfo[] {
  const byName = new Map<string, Conn[]>();
  for (const c of conns.values()) {
    if (c.userId !== userId || !c.ready || c.ws.readyState !== c.ws.OPEN) continue;
    (byName.get(c.name) ?? byName.set(c.name, []).get(c.name)!).push(c);
  }
  const out: VscodeBridgeInfo[] = [];
  for (const [name, list] of byName) {
    const workspaces: string[] = [];
    const seen = new Set<string>();
    const tools = new Set<string>();
    for (const c of list) {
      const r = c.ready!;
      for (const w of [r.cwd, ...r.workspaces]) if (w && !seen.has(normCwd(w))) { seen.add(normCwd(w)); workspaces.push(w); }
      for (const t of r.tools) tools.add(t);
    }
    const oldest = list.reduce((a, c) => (compareVersions(c.ready!.version, a.ready!.version) < 0 ? c : a), list[0]);
    out.push({
      name, kind: "vscode", cwd: list[list.length - 1].ready!.cwd, online: true,
      version: oldest.ready!.version, protocol: oldest.ready!.protocol, tools: [...tools],
      trusted: list.some((c) => c.ready!.trusted), busy: list.some((c) => c.run !== null),
      compat: { ok: list.every((c) => extensionCompatOk(c.ready!.version) && c.ready!.protocol === VSCODE_PROTOCOL), minVersion: VSCODE_EXT_MIN_VERSION },
      workspacesSupported: true, workspaces, allowAnyCwd: list.some((c) => c.ready!.allowAnyCwd),
      instances: list.length, remote: oldest.ready!.remote,
    });
  }
  return out;
}

/** True when a vscode bridge of this name is connected and ready (any instance). */
export const vscodeBridgeOnline = (userId: string, name: string): boolean => listVscodeBridges(userId).some((b) => b.name === name);

/* ---------- runs (S4) ---------- */

const hasCwd = (r: VscodeReady, cwd: string): boolean => {
  if (r.allowAnyCwd) return true;
  const want = normCwd(cwd);
  return normCwd(r.cwd) === want || r.workspaces.some((w) => normCwd(w) === want);
};

export interface OpenRunOptions {
  userId: string;
  /** bridge name (= provider baseUrl) */
  bridge: string;
  cwd: string;
  conversationId: string;
  approvalMode?: string;
  /** make a git checkpoint before the run (default true) */
  checkpoint?: boolean;
  /** tool roots; default [cwd] */
  roots?: string[];
  hooks?: VscodeRunHooks;
  signal?: AbortSignal;
}
export interface CallOptions {
  approval?: ToolApproval;
  /** how long the server waits for this call (ms). Default 60000; run_command: args.timeoutMs (default 120000) + 10 s */
  timeoutMs?: number;
}
export interface VscodeRun {
  readonly runId: string;
  readonly bridge: string;
  readonly instance: string;
  readonly cwd: string;
  readonly roots: string[];
  /** tools the extension advertised */
  readonly tools: string[];
  readonly approvalCapable: boolean;
  /** Resolves with the tool outcome; a timeout/cancel is an `ok:false` result. Rejects with VscodeBridgeError('disconnected'|'closed'). */
  callTool(tool: string, args: Record<string, unknown>, opts?: CallOptions): Promise<ToolResult>;
  /** Sends `cancel`; pending calls resolve as cancelled at once. Follow with closeRun() to wait for `done`. */
  cancel(): void;
  /** Sends the server-originated approval card to the extension's panel (spec 4.4). False when unsupported/offline. */
  sendFrame(frame: Record<string, unknown>): boolean;
  /** Resolves when the extension sent `done` (or the connection dropped). */
  readonly done: Promise<DoneInfo>;
}

const runs = new WeakMap<VscodeRun, { c: Conn; run: ActiveRun }>();

/** Picks the instance of `bridge` that has `cwd`. Throws offline / workspace_not_open / outdated / protocol / busy. */
function pickInstance(userId: string, bridge: string, cwd: string): Conn {
  const mine = [...conns.values()].filter((c) => c.userId === userId && c.name === bridge && c.ready && c.ws.readyState === c.ws.OPEN);
  if (!mine.length) throw new VscodeBridgeError("offline", `Bridge '${bridge}' is offline. Open VS Code with the OmniChat extension.`);
  const withCwd = mine.filter((c) => hasCwd(c.ready!, cwd));
  if (!withCwd.length) throw new VscodeBridgeError("workspace_not_open", `The folder is not open in any VS Code window of '${bridge}'. Open it in VS Code first.`);
  const free = withCwd.filter((c) => !c.run);
  if (!free.length) throw new VscodeBridgeError("busy", `VS Code window of '${bridge}' is busy with another run`);
  const c = free[0];
  if (!extensionCompatOk(c.ready!.version)) throw new VscodeBridgeError("outdated", outdatedMessage(c.ready!.version));
  if (c.ready!.protocol !== VSCODE_PROTOCOL) {
    throw new VscodeBridgeError("protocol", `VS Code extension protocol ${c.ready!.protocol} is not supported (server protocol ${VSCODE_PROTOCOL}). Update the .vsix.`);
  }
  if (!c.ready!.trusted) throw new VscodeBridgeError("untrusted_workspace", "The VS Code workspace is not trusted (Workspace Trust). Trust it to let the agent run.");
  return c;
}

export async function openRun(opts: OpenRunOptions): Promise<VscodeRun> {
  if (opts.signal?.aborted) throw new VscodeBridgeError("aborted", "aborted");
  const c = pickInstance(opts.userId, opts.bridge, opts.cwd);
  const runId = randomUUID();
  const run = newRun(runId, opts.hooks ?? {});
  c.run = run;
  const roots = opts.roots?.length ? opts.roots : [opts.cwd];
  const acked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      run.ack = null;
      reject(new VscodeBridgeError("no_ack", `Bridge '${opts.bridge}' did not acknowledge the run`));
    }, ACK_TIMEOUT_MS);
    timer.unref();
    run.ack = { resolve, reject, timer };
  });
  acked.catch(() => undefined);
  const sentOk = send(c, {
    type: "run", runId, conversationId: opts.conversationId, cwd: opts.cwd, approvalMode: opts.approvalMode ?? "manual",
    checkpoint: opts.checkpoint !== false, roots,
  });
  if (!sentOk) { finishRun(c, run, { ok: false, error: "offline" }); throw new VscodeBridgeError("offline", `Bridge '${opts.bridge}' is offline.`); }
  try {
    await acked;
  } catch (e) {
    if (c.run === run) { c.run = null; run.ended = true; run.settleDone({ ok: false, error: (e as Error).message }); }
    throw e;
  }

  const handle: VscodeRun = {
    runId, bridge: opts.bridge, instance: c.instance, cwd: opts.cwd, roots,
    tools: c.ready!.tools, approvalCapable: c.ready!.capabilities.approval, done: run.done,
    callTool(tool, args, copts = {}) {
      if (run.ended || c.run !== run) return Promise.reject(new VscodeBridgeError("closed", "Run is not active"));
      if (c.ws.readyState !== c.ws.OPEN) return Promise.reject(new VscodeBridgeError("disconnected", `Bridge '${c.name}' disconnected during the run`));
      if (run.cancelled) return Promise.resolve({ ok: false, error: { code: "cancelled", message: "Run was cancelled" } });
      const callId = "c" + randomUUID().slice(0, 8);
      const cmdMs = tool === "run_command" && typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : RUN_COMMAND_DEFAULT_MS;
      const timeoutMs = copts.timeoutMs ?? (tool === "run_command" ? cmdMs + RUN_COMMAND_GRACE_MS : DEFAULT_CALL_TIMEOUT_MS);
      return new Promise<ToolResult>((resolve, reject) => {
        const call: PendingCall = { callId, tool, timeoutMs, timer: null, startedAt: Date.now(), remaining: timeoutMs, paused: 0, resolve, reject };
        run.calls.set(callId, call);
        armCall(c, run, call, timeoutMs);
        const ok = send(c, { type: "tool_call", runId, callId, tool, args, ...(copts.approval ? { approval: copts.approval } : {}), timeoutMs });
        if (!ok) { clearCall(call); run.calls.delete(callId); reject(new VscodeBridgeError("disconnected", `Bridge '${c.name}' disconnected during the run`)); }
      });
    },
    cancel() {
      if (run.ended || run.cancelled) return;
      run.cancelled = true;
      send(c, { type: "cancel", runId });
      for (const call of [...run.calls.values()]) {
        clearCall(call);
        run.calls.delete(call.callId);
        call.resolve({ ok: false, error: { code: "cancelled", message: "Run was cancelled" } });
      }
    },
    sendFrame(frame) { return !run.ended && send(c, { ...frame, runId }); },
  };
  runs.set(handle, { c, run });
  opts.signal?.addEventListener("abort", () => handle.cancel(), { once: true });
  return handle;
}

/** Ends the loop: sends `run_end` and waits for the extension's `changes` + `done` (30 s). Never throws. */
export async function closeRun(handle: VscodeRun): Promise<DoneInfo> {
  const st = runs.get(handle);
  if (!st) return { ok: false, error: "unknown run" };
  const { c, run } = st;
  if (!run.ended) {
    send(c, { type: "run_end", runId: run.runId });
    const timer = setTimeout(() => {
      if (run.ended) return;
      send(c, { type: "cancel", runId: run.runId });
      finishRun(c, run, { ok: false, error: "The VS Code extension did not finish the run" });
    }, DONE_TIMEOUT_MS);
    timer.unref();
    await run.done;
    clearTimeout(timer);
  }
  return run.done;
}

export function cancelRun(handle: VscodeRun): void { handle.cancel(); }

/* ---------- rewind (S9 plugs in; kept here because it needs the instance pool) ---------- */

interface PendingRewind { conn: Conn; timer: NodeJS.Timeout; resolve(r: { ok: boolean; error?: string }): void }
const rewinds = new Map<string, PendingRewind>();
function settleRewind(requestId: string, conn: Conn | null, r: { ok: boolean; error?: string }): boolean {
  const p = rewinds.get(requestId);
  if (!p || (conn !== null && p.conn !== conn)) return false;
  rewinds.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(r);
  return true;
}

/** Asks the idle instance that has `cwd` to restore a checkpoint. 60 s timeout. */
export function requestVscodeRewind(userId: string, bridge: string, ref: string, cwd: string, removeNew: boolean): Promise<{ ok: boolean; error?: string }> {
  const c = [...conns.values()].find((x) => x.userId === userId && x.name === bridge && x.ready && x.ws.readyState === x.ws.OPEN && hasCwd(x.ready, cwd) && !x.run);
  if (!c) return Promise.resolve({ ok: false, error: `The folder is not open in any idle VS Code window of '${bridge}'` });
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleRewind(requestId, null, { ok: false, error: "bridge did not answer" }), 60_000);
    rewinds.set(requestId, { conn: c, timer, resolve });
    if (!send(c, { type: "rewind", requestId, ref, cwd, removeNew })) settleRewind(requestId, null, { ok: false, error: "bridge did not answer" });
  });
}
