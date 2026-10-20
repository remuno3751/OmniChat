import path from "node:path";
import WebSocket from "ws";
import { DshRun, runDsh, type DshEvent, type DshRunOptions } from "./dsh.js";
import { ModelCatalog, cordisPatchPath, defaultDshHome, writeModelOverlay, type ModelOverlay } from "./models.js";
import { Mirror, sessionLogMtime } from "./mirror.js";
import { AgentTracker } from "./agents.js";
import { computeChanges, createCheckpoint, rewindTo, type CheckpointResult, type FileChange } from "./gitops.js";
import { FsLimiter, listDir, readFile } from "./fsread.js";

export interface BridgeOptions {
  serverUrl: string;
  /** Returns the auth token; called on every (re)connect. */
  getToken: () => Promise<string>;
  /** Called when the server rejects the token (HTTP 401/403), so the caller can drop a cached token. */
  onAuthFailure?: () => void;
  name: string;
  cwd: string;
  /** dsh launch options minus per-run fields. */
  dsh: Omit<DshRunOptions, "prompt" | "sessionId" | "cwd">;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  pingIntervalMs?: number;
  log?: (msg: string) => void;
  /** dsh home (default ~/.dsh): profiles (models) and sessions (mirroring). */
  dshHome?: string;
  /** Mirror dsh session logs to the server (default true). */
  mirror?: boolean;
  /** Mirror sessions of every cwd, not just this bridge's. */
  mirrorAll?: boolean;
  /** Serve read-only file requests (`fs`) for Code preview. Default false (BRIDGE-v2.md, section C). */
  previewFs?: boolean;
  /** Poll interval of the upstream /models endpoints (default 10000 ms). */
  liveMs?: number;
  /** fetch override for tests. */
  fetchImpl?: import("./live.js").FetchLike;
  /** Poll interval for session logs / model file (default 1500 ms). */
  pollMs?: number;
  /** Log changed within this window = a GUI is writing it (default 3000 ms). */
  busyWindowMs?: number;
  /** stderr warning sink for mirroring format problems. */
  warn?: (msg: string) => void;
}

interface ActiveRun {
  runId: string;
  run: DshRun;
  cancelled: boolean;
}

/** Same directory? Case-insensitive on Windows. */
function sameDir(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function toWsUrl(serverUrl: string, name: string, token: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  u.pathname = u.pathname.replace(/\/+$/, "") + "/bridge";
  u.search = "";
  u.searchParams.set("token", token);
  u.searchParams.set("name", name);
  return u.toString();
}

export class Bridge {
  private ws: WebSocket | null = null;
  private stopped = false;
  private active: ActiveRun | null = null;
  /** True from the start of a run (or a rewind) until it has fully ended; treated as busy. */
  private starting = false;
  /** runId of a run still being set up (checkpoint), and whether a cancel arrived meanwhile. */
  private startingRunId: string | null = null;
  private startCancelled = false;
  private delay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  private readonly dshHome: string;
  private readonly catalog: ModelCatalog;
  private readonly mirror: Mirror | null;
  /** log mtime recorded when our own run on that session ended (our writes are not "busy"). */
  private ownMtime = new Map<string, number>();
  private readonly fsLimiter = new FsLimiter();
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly log: (m: string) => void;

  constructor(private o: BridgeOptions) {
    this.minMs = o.reconnectMinMs ?? 1000;
    this.maxMs = o.reconnectMaxMs ?? 30000;
    this.delay = this.minMs;
    this.log = o.log ?? (() => {});
    this.dshHome = o.dshHome ?? defaultDshHome();
    this.catalog = new ModelCatalog(cordisPatchPath(this.dshHome, o.dsh.profile), o.dsh.patch ?? null, { fetch: o.fetchImpl, onError: (m) => this.log(m) });
    this.catalog.check();
    this.mirror =
      o.mirror === false
        ? null
        : new Mirror({ dshHome: this.dshHome, cwd: o.cwd, mirrorAll: o.mirrorAll, warn: o.warn });
  }

  private modelsPayload() {
    return {
      models: this.catalog.models,
      ...(this.catalog.defaultModel ? { defaultModel: this.catalog.defaultModel } : {}),
    };
  }

  private startPolling(ws: WebSocket): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.ws !== ws) return;
      try {
        if (this.catalog.check()) this.send(ws, { type: "models", ...this.modelsPayload() });
      } catch (e) {
        this.log(`model refresh failed: ${(e as Error).message}`);
      }
      try {
        const f = this.mirror?.poll();
        if (f) this.send(ws, f);
      } catch (e) {
        this.log(`mirror poll failed: ${(e as Error).message}`);
      }
    }, this.o.pollMs ?? 1500);
    this.pollTimer.unref();
    this.liveTimer = setInterval(() => { if (this.ws === ws) this.liveRefresh(ws); }, this.o.liveMs ?? 10000);
    this.liveTimer.unref();
    this.liveRefresh(ws);
  }

  private liveRefresh(ws: WebSocket): void {
    this.catalog.refreshLive().then(
      (changed) => { if (changed && this.ws === ws) this.send(ws, { type: "models", ...this.modelsPayload() }); },
      () => { /* never include error details here */ },
    );
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearPing();
    this.stopPolling();
    this.active?.run.cancel();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, "bridge shutdown"); } catch { /* ignore */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 1000).unref();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const d = this.delay;
    this.delay = Math.min(this.delay * 2, this.maxMs);
    this.log(`reconnecting in ${Math.round(d / 100) / 10}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, d);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let token: string;
    try {
      token = await this.o.getToken();
    } catch (e) {
      this.log(`auth failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(this.o.serverUrl, this.o.name, token));
    } catch (e) {
      this.log(`connect error: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let alive = true;
    let closed = false;

    const onClosed = () => {
      if (closed) return;
      closed = true;
      this.clearPing();
      this.stopPolling();
      if (this.ws === ws) this.ws = null;
      if (this.active) {
        this.log(`connection lost, killing run ${this.active.runId}`);
        this.active.run.cancel();
      }
      this.scheduleReconnect();
    };

    ws.on("open", () => {
      this.delay = this.minMs;
      this.log(`connected as '${this.o.name}'`);
      alive = true;
      this.catalog.check();
      this.send(ws, {
        type: "ready",
        name: this.o.name,
        cwd: this.o.cwd,
        ...this.modelsPayload(),
        ...(this.o.previewFs ? { capabilities: { fs: true } } : {}),
      });
      try {
        const f = this.mirror?.full();
        if (f) this.send(ws, f);
      } catch (e) {
        this.log(`mirror snapshot failed: ${(e as Error).message}`);
      }
      this.startPolling(ws);
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (!alive) {
          this.log("no pong, terminating connection");
          ws.terminate();
          return;
        }
        alive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }, this.o.pingIntervalMs ?? 20000);
      this.pingTimer.unref();
    });
    ws.on("pong", () => { alive = true; });
    ws.on("ping", () => { alive = true; });
    ws.on("message", (data) => {
      alive = true;
      this.onMessage(ws, data.toString());
    });
    ws.on("unexpected-response", (_req, res) => {
      this.log(`server rejected connection: HTTP ${res.statusCode}`);
      if (res.statusCode === 401 || res.statusCode === 403) this.o.onAuthFailure?.();
      res.resume();
      onClosed();
    });
    ws.on("error", (e) => this.log(`socket error: ${e.message}`));
    ws.on("close", () => {
      if (!this.stopped) this.log("disconnected");
      onClosed();
    });
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onMessage(ws: WebSocket, text: string): void {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.type === "run" && typeof m.runId === "string" && typeof m.prompt === "string") {
      const sid = typeof m.sessionId === "string" && m.sessionId ? m.sessionId : null;
      const model = typeof m.model === "string" && m.model && m.model !== "dsh" ? m.model : null;
      void this.handleRun(ws, m.runId, sid, m.prompt, model);
    } else if (m.type === "cancel" && typeof m.runId === "string") {
      if (this.active && this.active.runId === m.runId) {
        this.active.cancelled = true;
        this.active.run.cancel();
      } else if (this.starting && this.startingRunId === m.runId) {
        this.startCancelled = true;
      }
    } else if (m.type === "rewind" && typeof m.requestId === "string") {
      void this.handleRewind(ws, m);
    } else if (m.type === "fs" && typeof m.requestId === "string") {
      this.handleFs(ws, m);
    }
  }

  /** Read-only preview access (`fs`). Runs even while a run is in progress; the bridge enforces every limit. */
  private handleFs(ws: WebSocket, m: Record<string, any>): void {
    const requestId = m.requestId as string;
    const reply = (fields: Record<string, unknown>) => this.send(ws, { type: "fs_result", requestId, ...fields });
    if (!this.o.previewFs) return reply({ ok: false, error: "preview is disabled on this bridge" });
    const release = this.fsLimiter.admit();
    if (!release) return reply({ ok: false, error: "too many requests" });
    try {
      if (typeof m.cwd !== "string" || !sameDir(m.cwd, this.o.cwd)) {
        return reply({ ok: false, error: "cwd does not match the bridge working directory" });
      }
      const op = m.op === "list" || m.op === "read" ? (m.op as "list" | "read") : null;
      if (!op) return reply({ ok: false, error: "invalid op" });
      const p = m.path === undefined ? "" : m.path;
      const r = op === "list" ? listDir(this.o.cwd, p) : readFile(this.o.cwd, p, m.maxBytes);
      const shown = typeof p === "string" ? p.slice(0, 200) : "";
      this.log(`fs ${op} ${shown}: ${r.ok ? "ok" : r.error}`);
      reply({ ...r });
    } catch {
      reply({ ok: false, error: "read failed" });
    } finally {
      release();
    }
  }

  private async handleRewind(ws: WebSocket, m: Record<string, any>): Promise<void> {
    const requestId = m.requestId as string;
    const reply = (fields: Record<string, unknown>) => this.send(ws, { type: "rewound", requestId, ...fields });
    if (this.active || this.starting) return reply({ ok: false, error: "a run is in progress" });
    if (typeof m.cwd !== "string" || !sameDir(m.cwd, this.o.cwd)) {
      return reply({ ok: false, error: "cwd does not match the bridge working directory" });
    }
    if (typeof m.ref !== "string") return reply({ ok: false, error: "invalid ref" });
    this.starting = true;
    try {
      const r = await rewindTo(this.o.cwd, m.ref, { removeNew: m.removeNew === true });
      this.log(r.ok ? `rewind ok (restored ${r.restored ?? 0}, removed ${r.removed ?? 0})` : "rewind failed");
      reply({
        ok: r.ok,
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.restored !== undefined ? { restored: r.restored } : {}),
        ...(r.removed !== undefined ? { removed: r.removed } : {}),
        ...(r.backupRef !== undefined ? { backupRef: r.backupRef } : {}),
      });
    } catch (e) {
      reply({ ok: false, error: (e as Error).message });
    } finally {
      this.starting = false;
    }
  }

  private async handleRun(ws: WebSocket, runId: string, sessionId: string | null, prompt: string, model: string | null = null): Promise<void> {
    if (this.active || this.starting) {
      this.send(ws, { type: "done", runId, ok: false, sessionId, error: "busy" });
      return;
    }
    this.starting = true;
    this.startingRunId = runId;
    this.startCancelled = false;
    try {
      await this.runAgent(ws, runId, sessionId, prompt, model);
    } finally {
      this.starting = false;
      this.startingRunId = null;
      this.startCancelled = false;
    }
  }

  private async runAgent(ws: WebSocket, runId: string, sessionId: string | null, prompt: string, model: string | null): Promise<void> {
    if (sessionId) {
      const mt = sessionLogMtime(this.dshHome, sessionId);
      if (mt !== null && Date.now() - mt < (this.o.busyWindowMs ?? 3000) && mt > (this.ownMtime.get(sessionId) ?? 0)) {
        this.send(ws, { type: "done", runId, ok: false, sessionId, error: "session busy in dsh" });
        return;
      }
    }
    let overlay: ModelOverlay | null = null;
    if (model) {
      try {
        const bare = model.includes("::") ? null : this.catalog.providerFor(model);
        overlay = writeModelOverlay(model, bare);
      } catch (e) {
        this.send(ws, { type: "done", runId, ok: false, sessionId, error: `cannot write model overlay: ${(e as Error).message}` });
        return;
      }
    }
    let cp: CheckpointResult | null = null;
    let active: ActiveRun | null = null;
    let seenSession: string | null = null;
    let turnError: string | null = null;
    try {
      cp = await createCheckpoint(this.o.cwd);
      if (cp.ok) {
        const c = cp.checkpoint;
        this.send(ws, { type: "checkpoint", requestId: runId, checkpointId: c.checkpointId, ref: c.ref, createdAt: c.createdAt, dirty: c.dirty });
        this.log(`run ${runId} checkpoint ${c.checkpointId} (${c.dirty ? "dirty" : "clean"})`);
      } else {
        this.send(ws, { type: "checkpoint", requestId: runId, unavailable: cp.unavailable });
        this.log(`run ${runId} no checkpoint: ${cp.unavailable}`);
      }

      if (this.startCancelled) {
        this.log(`run ${runId} cancelled before start`);
        this.send(ws, { type: "done", runId, ok: false, sessionId, error: "cancelled", ...(cp.ok ? {} : { warning: cp.unavailable }) });
        return;
      }
      this.log(`run ${runId} start (${sessionId ? "resume" : "new session"}, ${prompt.length} chars)`);
      const run = runDsh({ ...this.o.dsh, modelPatch: overlay?.file ?? null, cwd: this.o.cwd, sessionId, prompt });
      const current: ActiveRun = { runId, run, cancelled: false };
      active = current;
      this.active = current;
      const tracker = new AgentTracker({
        dshHome: this.dshHome,
        onChange: (agents) => this.send(ws, { type: "agents", requestId: runId, agents }),
      });
      for await (const ev of run as AsyncIterable<DshEvent>) {
        if (ev.type === "session" && typeof ev.sessionId === "string") seenSession = ev.sessionId;
        if (ev.type === "status" && ev.phase === "turn_end") {
          const r = ev.reason as { kind?: string; error?: { message?: string } } | undefined;
          if (r?.kind === "error") turnError = r.error?.message ?? "dsh turn failed";
        }
        this.send(ws, { type: "event", runId, event: ev });
        try {
          tracker.onEvent(ev);
        } catch (e) {
          this.log(`agent tracking failed: ${(e as Error).message}`);
        }
      }
      const res = await run.done;
      try {
        tracker.finalize();
      } catch (e) {
        this.log(`agent tracking failed: ${(e as Error).message}`);
      }

      let changes: FileChange[] = [];
      if (cp.ok) {
        try {
          changes = (await computeChanges(this.o.cwd, cp.checkpoint.tree)).changes;
        } catch (e) {
          this.log(`change detection failed: ${(e as Error).message}`);
        }
      }
      this.log(`run ${runId} changes ${changes.length}`);
      this.send(ws, { type: "changes", requestId: runId, changes });

      const cancelled = current.cancelled || res.cancelled;
      const ok = !cancelled && res.code === 0 && !turnError;
      let error: string | undefined;
      if (cancelled) error = "cancelled";
      else if (!ok) error = turnError ?? (res.stderrTail || `dsh exited with code ${res.code}`);
      const warning = cp.ok ? undefined : cp.unavailable;
      this.log(`run ${runId} end ok=${ok}${error ? ` error=${error.slice(0, 200)}` : ""}`);
      this.send(ws, {
        type: "done",
        runId,
        ok,
        sessionId: seenSession ?? sessionId,
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
      });
    } finally {
      if (this.active === active) this.active = null;
      overlay?.cleanup();
      const sid = seenSession ?? sessionId;
      if (sid) {
        const mt = sessionLogMtime(this.dshHome, sid);
        if (mt !== null) this.ownMtime.set(sid, mt);
      }
    }
  }
}
