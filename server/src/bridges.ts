import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { deviceFromToken } from "./auth.js";
import { handleSessionsFrame, handleBridgeDisconnect } from "./mirror.js";
import { db, getMessageRow, setMessageV4, toMessage, type AgentRecord, type FileChange } from "./db.js";
import { broadcast } from "./hub.js";
import { isValidCwd, normCwd } from "./cwd.js";
import { requestBridgeApproval } from "./tools/approvals.js";
import { listOmniModels, mintDshKey, revokeDshKey } from "./omni-models.js";
import { handleVscodeUpgrade, isValidInstance, listVscodeBridges, closeVscodeDeviceBridges, type VscodeBridgeInfo } from "./vscode-bridge.js";

export type DshEvent = { type: string; [k: string]: any };

type Item = { event?: DshEvent; done?: { ok: boolean; sessionId: string | null; error?: string }; fail?: Error };
/** Who a run belongs to (set by runOnBridge from req.context). */
export interface RunCtx { userId: string; conversationId: string; assistantMessageId: string | null; projectId: string | null }
interface Run { push(item: Item): void; ctx?: RunCtx }
export interface BridgeModel { provider: string; id: string; name: string; providerName?: string; imported?: boolean }
interface Bridge {
  deviceId: string;
  userId: string;
  models: BridgeModel[];
  defaultModel: string | null;
  ws: WebSocket;
  name: string;
  cwd: string;
  /** known working folders, most recent first (plugin >= 0.9.0); workspacesSupported tells old plugins apart */
  workspaces: string[];
  workspacesSupported: boolean;
  allowAnyCwd: boolean;
  alive: boolean;
  runs: Map<string, Run>;
  /** context of runs that finished within the last 30 s (late v4 frames) */
  recent: Map<string, RunCtx>;
  /** public base url of this server as seen by the bridge (PROTOCOL v7 2.1), null if unknown */
  publicBase: string | null;
  /** times of omni_key_request frames (rolling minute) */
  keyRequests: number[];
  /** version of the omnichat-dsh-bridge plugin, from the ready frame (<= 40 chars) */
  pluginVersion?: string;
  /** optional features the bridge reports in its ready frame (`capabilities`); absent = none */
  capabilities: { fs?: boolean };
}

const bridges = new Map<string, Bridge>(); // key: userId \0 name
const key = (userId: string, name: string) => `${userId}\u0000${name}`;
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

const clipStr = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
/** Truncates a string so its UTF-8 size is at most `n` bytes. */
const capBytes = (s: string, n: number): string => {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  return buf.subarray(0, n).toString("utf8").replace(/�$/, "");
};
const PATCH_FILE_CAP = 200 * 1024;
const PATCH_TOTAL_CAP = 1024 * 1024;
const nonNegInt = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** Sanitizes a bridge `changes` payload (PROTOCOL-v4 section 3). */
export function sanitizeChanges(raw: unknown): FileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: FileChange[] = [];
  let budget = PATCH_TOTAL_CAP;
  for (const c of raw) {
    if (out.length >= 500) break;
    if (typeof c !== "object" || c === null) continue;
    const path = clipStr((c as any).path, 1000);
    if (!path) continue;
    const st = (c as any).status;
    const status: FileChange["status"] = st === "added" || st === "modified" || st === "deleted" || st === "renamed" ? st : "modified";
    const change: FileChange = { path, status, additions: nonNegInt((c as any).additions), deletions: nonNegInt((c as any).deletions) };
    const p = (c as any).patch;
    if (typeof p === "string" && p) {
      const capped = capBytes(p, PATCH_FILE_CAP);
      const size = Buffer.byteLength(capped, "utf8");
      if (size <= budget) { change.patch = capped; budget -= size; }
    }
    out.push(change);
  }
  return out;
}

/** Sanitizes a bridge `agents` payload (PROTOCOL-v4 section 3). Rows with an unknown status are dropped. */
function sanitizeAgents(raw: unknown): AgentRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentRecord[] = [];
  for (const a of raw) {
    if (out.length >= 50) break;
    if (typeof a !== "object" || a === null) continue;
    const id = clipStr((a as any).id, 200);
    const st = (a as any).status;
    if (!id || (st !== "running" && st !== "done" && st !== "error")) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const rec: AgentRecord = {
      id,
      role: clipStr((a as any).role, 100),
      status: st,
      startedAt: num((a as any).startedAt) ?? 0,
      endedAt: num((a as any).endedAt),
    };
    if (typeof (a as any).summary === "string") rec.summary = clipStr((a as any).summary, 2000);
    if (typeof (a as any).log === "string") rec.log = capBytes((a as any).log, 64 * 1024);
    out.push(rec);
  }
  return out;
}

/** Pending rewind requests (requestId -> settle). A bridge key is kept so a dropped bridge can fail its rewinds. */
interface PendingRewind { bridgeKey: string; timer: NodeJS.Timeout; resolve(r: { ok: boolean; error?: string }): void }
const rewinds = new Map<string, PendingRewind>();
function settleRewind(requestId: string, bridgeKey: string | null, r: { ok: boolean; error?: string }): boolean {
  const p = rewinds.get(requestId);
  if (!p || (bridgeKey !== null && p.bridgeKey !== bridgeKey)) return false;
  rewinds.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(r);
  return true;
}

/** Preview file-access results (Code preview, PROTOCOL in docs/design/CODE-PREVIEW.md). */
export interface FsEntry { name: string; kind: "file" | "dir"; size: number }
export interface FsResult {
  ok: boolean;
  error?: string;
  /** set by the server itself: preview_unavailable | bridge_offline | timeout | too_large; undefined for a bridge-reported error */
  code?: "preview_unavailable" | "bridge_offline" | "timeout" | "too_large";
  entries?: FsEntry[];
  /** base64 of the file bytes */
  content?: string;
  size?: number;
  mime?: string;
  truncated?: boolean;
}
/** Largest accepted base64 `content` string (server-side double check of the bridge's own 3 MB read limit). */
export const FS_CONTENT_B64_MAX = 4 * 1024 * 1024;
interface PendingFs { bridgeKey: string; timer: NodeJS.Timeout; resolve(r: FsResult): void }
const fsRequests = new Map<string, PendingFs>();
function settleFs(requestId: string, bridgeKey: string | null, r: FsResult): boolean {
  const p = fsRequests.get(requestId);
  if (!p || (bridgeKey !== null && p.bridgeKey !== bridgeKey)) return false;
  fsRequests.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(r);
  return true;
}
function sanitizeEntries(raw: unknown): FsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FsEntry[] = [];
  for (const e of raw.slice(0, 2000)) {
    if (!e || typeof e !== "object") continue;
    const name = clipStr((e as any).name, 255);
    if (!name) continue;
    out.push({ name, kind: (e as any).kind === "dir" ? "dir" : "file", size: nonNegInt((e as any).size) });
  }
  return out;
}
/** A `fs_result` frame from the bridge: sanitized, then settles the pending request (matched by bridge key). */
function handleFsResult(k: string, m: any): void {
  try {
    const requestId = m.requestId as string;
    if (m.ok !== true) {
      settleFs(requestId, k, { ok: false, error: clipStr(m.error, 2000) || "preview failed" });
      return;
    }
    if (typeof m.content === "string" && m.content.length > FS_CONTENT_B64_MAX) {
      settleFs(requestId, k, { ok: false, error: "file too large for preview", code: "too_large" });
      return;
    }
    settleFs(requestId, k, {
      ok: true,
      ...(Array.isArray(m.entries) ? { entries: sanitizeEntries(m.entries) } : {}),
      ...(typeof m.content === "string" ? { content: m.content } : {}),
      ...(typeof m.size === "number" ? { size: nonNegInt(m.size) } : {}),
      ...(typeof m.mime === "string" ? { mime: clipStr(m.mime, 100) } : {}),
      ...(m.truncated === true ? { truncated: true } : {}),
    });
  } catch {
    /* a malformed frame must not take the server down */
  }
}

/** Handles the v4 bridge->server frames that belong to a run (changes, agents, checkpoint, approval, rewound). Never throws. */
function handleV4Frame(b: Bridge, m: any): void {
  try {
    const runCtx = (): RunCtx | undefined => (typeof m.requestId === "string" ? (b.runs.get(m.requestId)?.ctx ?? b.recent.get(m.requestId)) : undefined);
    switch (m.type) {
      case "changes": {
        const ctx = runCtx();
        if (!ctx?.assistantMessageId) return;
        const changes = sanitizeChanges(m.changes);
        setMessageV4(ctx.assistantMessageId, { changes });
        const row = getMessageRow(ctx.assistantMessageId);
        if (row) broadcast(ctx.userId, { type: "upsert", messages: [toMessage(row)] });
        return;
      }
      case "agents": {
        const ctx = runCtx();
        if (!ctx?.assistantMessageId) return;
        const agents = sanitizeAgents(m.agents);
        setMessageV4(ctx.assistantMessageId, { agents });
        const row = getMessageRow(ctx.assistantMessageId);
        if (row) broadcast(ctx.userId, { type: "upsert", messages: [toMessage(row)] });
        return;
      }
      case "checkpoint": {
        const ctx = runCtx();
        const checkpointId = clipStr(m.checkpointId, 200);
        if (!ctx || !checkpointId) return;
        const createdAt = typeof m.createdAt === "number" && Number.isFinite(m.createdAt) ? m.createdAt : Date.now();
        const dirty = m.dirty === true ? 1 : 0;
        const unavailable = typeof m.unavailable === "string" ? clipStr(m.unavailable, 500) || "unavailable" : null;
        const ref = unavailable || typeof m.ref !== "string" || !m.ref ? null : clipStr(m.ref, 200);
        db.prepare(
          "INSERT OR REPLACE INTO checkpoints (id, user_id, conversation_id, message_id, bridge, cwd, ref, unavailable, dirty, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(checkpointId, ctx.userId, ctx.conversationId, ctx.assistantMessageId, b.name, b.cwd, ref, unavailable, dirty, createdAt);
        if (unavailable) {
          broadcast(ctx.userId, { type: "checkpoint_unavailable", conversationId: ctx.conversationId, messageId: ctx.assistantMessageId, reason: unavailable });
        } else {
          broadcast(ctx.userId, { type: "checkpoint", conversationId: ctx.conversationId, messageId: ctx.assistantMessageId, checkpointId, createdAt, dirty: dirty === 1 });
        }
        return;
      }
      case "approval": {
        const ctx = runCtx();
        const approvalId = clipStr(m.approvalId, 200);
        if (!ctx || !approvalId) return;
        const tool = clipStr(m.tool, 200) || "tool";
        const opt = (v: unknown, n: number) => (typeof v === "string" ? clipStr(v, n) : undefined);
        const ws = b.ws;
        requestBridgeApproval({
          userId: ctx.userId, conversationId: ctx.conversationId, messageId: ctx.assistantMessageId ?? "",
          projectId: ctx.projectId, approvalId, tool,
          command: opt(m.command, 4000), path: opt(m.path, 1000), reason: opt(m.reason, 1000), signal: undefined,
        })
          .then(({ decision }) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "approval_reply", approvalId, decision }));
          })
          .catch(() => { /* ignore: the bridge will time out on its side */ });
        return;
      }
      case "rewound": {
        if (typeof m.requestId !== "string") return;
        const error = clipStr(m.error, 2000) || undefined;
        const ok = m.ok === true;
        settleRewind(m.requestId, key(b.userId, b.name), ok ? { ok: true } : { ok: false, error: error ?? "rewind failed" });
        return;
      }
    }
  } catch {
    /* a malformed frame must not take the server down */
  }
}
const MAX_WORKSPACES = 50;
function sanitizeWorkspaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (!isValidCwd(w) || seen.has(normCwd(w))) continue;
    seen.add(normCwd(w));
    out.push(w);
    if (out.length >= MAX_WORKSPACES) break;
  }
  return out;
}

function sanitizeModels(raw: unknown): BridgeModel[] {
  if (!Array.isArray(raw)) return [];
  const out: BridgeModel[] = [];
  for (const m of raw.slice(0, 500)) {
    if (typeof m !== "object" || m === null) continue;
    const id = clipStr((m as any).id, 200).trim();
    if (!id) continue;
    const provider = clipStr((m as any).provider, 100).trim();
    const entry: BridgeModel = { provider, id, name: clipStr((m as any).name, 200).trim() || id };
    const providerName = clipStr((m as any).providerName, 100).trim();
    if (providerName) entry.providerName = providerName;
    if ((m as any).imported === true) entry.imported = true;
    out.push(entry);
  }
  return out;
}

/** Models the named bridge last reported ([] if offline). */
export function getBridgeModels(userId: string, name: string): { models: BridgeModel[]; defaultModel: string | null; online: boolean } {
  const b = bridges.get(key(userId, name));
  if (!b || b.ws.readyState !== b.ws.OPEN) return { models: [], defaultModel: null, online: false };
  return { models: b.models, defaultModel: b.defaultModel, online: true };
}

export const offlineError = (name: string) => `Bridge '${name}' is offline. Start the bridge on your PC.`;

export interface BridgeInfo {
  name: string; cwd: string; online: true; pluginVersion?: string;
  /** Code workspaces (plugin >= 0.9.0) */
  workspacesSupported: boolean; workspaces: string[]; allowAnyCwd: boolean;
}
export function listBridges(userId: string): (BridgeInfo | VscodeBridgeInfo)[] {
  const out: (BridgeInfo | VscodeBridgeInfo)[] = [];
  for (const [k, b] of bridges) {
    if (!k.startsWith(userId + "\u0000") || b.ws.readyState !== b.ws.OPEN) continue;
    out.push({
      name: b.name, cwd: b.cwd, online: true, ...(b.pluginVersion ? { pluginVersion: b.pluginVersion } : {}),
      workspacesSupported: b.workspacesSupported, workspaces: b.workspaces, allowAnyCwd: b.allowAnyCwd,
    });
  }
  out.push(...listVscodeBridges(userId));
  return out;
}

/**
 * Server-side check of a working folder chosen for a new Code chat (the plugin decides again). The format is always checked;
 * when the bridge is online, supports workspaces and is not in allowAnyCwd mode, the folder must be one it reported.
 * Returns an error text, or null when acceptable. An offline bridge is left to the plugin.
 */
export function cwdRefusal(userId: string, bridgeName: string, cwd: unknown): string | null {
  if (!isValidCwd(cwd)) return "Invalid cwd";
  const b = bridges.get(key(userId, bridgeName));
  if (!b || b.ws.readyState !== b.ws.OPEN || !b.workspacesSupported || b.allowAnyCwd) return null;
  const want = normCwd(cwd);
  if (normCwd(b.cwd) === want || b.workspaces.some((w) => normCwd(w) === want)) return null;
  return "cwd is not a known workspace of this bridge";
}

/** Every connected bridge of every user (local admin overview). */
export function listAllBridges(): { userId: string; name: string; cwd: string }[] {
  const out: { userId: string; name: string; cwd: string }[] = [];
  for (const b of bridges.values()) if (b.ws.readyState === b.ws.OPEN) out.push({ userId: b.userId, name: b.name, cwd: b.cwd });
  return out;
}

function dropBridge(k: string, b: Bridge, reason: string) {
  if (bridges.get(k) === b) bridges.delete(k);
  const runs = [...b.runs.values()];
  b.runs.clear();
  for (const r of runs) r.push({ fail: new Error(reason) });
  for (const id of [...rewinds.keys()]) settleRewind(id, k, { ok: false, error: "bridge disconnected" });
  for (const id of [...fsRequests.keys()]) settleFs(id, k, { ok: false, error: "bridge disconnected", code: "bridge_offline" });
  handleBridgeDisconnect(b.userId, b.name);
}

/** Public base url of this server as a client on the bridge PC reaches it: OMNICHAT_PUBLIC_URL, else derived from the request. Null if unknown. */
export function publicBaseUrl(req: IncomingMessage): string | null {
  const env = (process.env.OMNICHAT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (env) return env;
  const first = (v: unknown) => String(Array.isArray(v) ? v[0] : v ?? "").split(",")[0].trim();
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host);
  if (!host) return null;
  const proto = first(req.headers["x-forwarded-proto"]) || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

const OMNI_KEY_RATE = 5;
const OMNI_KEY_WINDOW_MS = 60_000;

/** Answers the PROTOCOL v7 2.1 omni_* frames on the bridge socket. Never throws. */
async function handleOmniFrame(b: Bridge, m: any): Promise<void> {
  const requestId = typeof m.requestId === "string" ? clipStr(m.requestId, 100) : null;
  if (requestId === null) return;
  const type = m.type === "omni_models_request" ? "omni_models" : m.type === "omni_key_request" ? "omni_key" : "omni_key_revoked";
  const reply = (o: Record<string, unknown>) => {
    try { if (b.ws.readyState === b.ws.OPEN) b.ws.send(JSON.stringify({ type, requestId, ...o })); } catch { /* ignore */ }
  };
  const fail = (error: string) => reply({ ok: false, error });
  try {
    if (m.type === "omni_models_request") {
      if (!b.publicBase) return fail("public url unknown");
      const models = await listOmniModels(b.userId);
      reply({ ok: true, baseUrl: `${b.publicBase}/v1`, models });
    } else if (m.type === "omni_key_request") {
      const now = Date.now();
      b.keyRequests = b.keyRequests.filter((t) => now - t < OMNI_KEY_WINDOW_MS);
      if (b.keyRequests.length >= OMNI_KEY_RATE) return fail("rate limited");
      b.keyRequests.push(now);
      const k = mintDshKey(b.userId, b.name);
      reply({ ok: true, keyId: k.id, apiKey: k.key });
    } else if (m.type === "omni_key_revoke") {
      if (typeof m.keyId !== "string" || !m.keyId) return fail("keyId required");
      const keyId = clipStr(m.keyId, 100);
      if (!revokeDshKey(b.userId, keyId)) return fail("key not found");
      reply({ ok: true });
    }
  } catch {
    fail("server error");
  }
}

export function handleBridgeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
  const user = deviceFromToken(url.searchParams.get("token"));
  const name = (url.searchParams.get("name") ?? "").trim();
  const kind = url.searchParams.get("kind") ?? "dsh";
  const instance = url.searchParams.get("instance") ?? "";
  if (!user || !name || (kind !== "dsh" && kind !== "vscode") || (kind === "vscode" && !isValidInstance(instance))) {
    socket.write(`HTTP/1.1 ${user ? "400 Bad Request" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`);
    return void socket.destroy();
  }
  if (kind === "vscode") return handleVscodeUpgrade(req, socket, head, user, name, instance);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const k = key(user.userId, name);
    const old = bridges.get(k);
    const b: Bridge = { deviceId: user.deviceId, userId: user.userId, models: [], defaultModel: null, ws, name, cwd: "", workspaces: [], workspacesSupported: false, allowAnyCwd: false, alive: true, runs: new Map(), recent: new Map(), publicBase: publicBaseUrl(req), keyRequests: [], capabilities: {} };
    if (old) {
      dropBridge(k, old, `Bridge '${name}' was replaced by a new connection`);
      try { old.ws.close(4000, "replaced"); } catch { /* ignore */ }
    }
    bridges.set(k, b);

    const timer = setInterval(() => {
      if (!b.alive) { ws.terminate(); return; }
      b.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, 20000);
    timer.unref();
    ws.on("pong", () => { b.alive = true; });

    ws.on("message", (raw) => {
      b.alive = true;
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.type === "ready") {
        b.cwd = typeof m.cwd === "string" ? m.cwd.slice(0, 1000) : "";
        b.capabilities = { fs: m.capabilities?.fs === true };
        b.workspacesSupported = m.capabilities?.workspaces === true;
        b.allowAnyCwd = m.allowAnyCwd === true;
        b.workspaces = sanitizeWorkspaces(m.workspaces);
        const pv = clipStr(m.pluginVersion ?? m.version, 40);
        if (pv) b.pluginVersion = pv;
        if ("models" in m) b.models = sanitizeModels(m.models);
        if ("defaultModel" in m) b.defaultModel = clipStr(m.defaultModel, 400) || null;
      } else if (m?.type === "workspaces") {
        b.workspaces = sanitizeWorkspaces(m.workspaces);
        if ("allowAnyCwd" in m) b.allowAnyCwd = m.allowAnyCwd === true;
        b.workspacesSupported = true;
      } else if (m?.type === "models") {
        b.models = sanitizeModels(m.models);
        if ("defaultModel" in m) b.defaultModel = clipStr(m.defaultModel, 400) || null;
      } else if (m?.type === "sessions") {
        if (bridges.get(k) === b) handleSessionsFrame(user.userId, name, m);
      } else if (m?.type === "fs_result" && typeof m.requestId === "string") {
        handleFsResult(k, m);
      } else if (m?.type === "event" && typeof m.runId === "string") {
        b.runs.get(m.runId)?.push({ event: m.event });
      } else if (m?.type === "done" && typeof m.runId === "string") {
        const r = b.runs.get(m.runId);
        b.runs.delete(m.runId);
        // changes / agents / checkpoint frames may arrive just after `done`: keep the context briefly
        if (r?.ctx) { const id = m.runId as string; b.recent.set(id, r.ctx); setTimeout(() => b.recent.delete(id), 30_000).unref(); }
        r?.push({ done: { ok: !!m.ok, sessionId: typeof m.sessionId === "string" ? m.sessionId : null, error: m.error } });
      } else if (m?.type === "changes" || m?.type === "agents" || m?.type === "checkpoint" || m?.type === "approval" || m?.type === "rewound") {
        handleV4Frame(b, m);
      } else if (m?.type === "omni_models_request" || m?.type === "omni_key_request" || m?.type === "omni_key_revoke") {
        void handleOmniFrame(b, m);
      }
    });
    const gone = () => {
      clearInterval(timer);
      dropBridge(k, b, `Bridge '${name}' disconnected during the run`);
    };
    ws.on("close", gone);
    ws.on("error", gone);
  });
}

/** Run a prompt on a connected bridge. Yields dsh events; a synthetic
 *  {type:"session"} event is emitted from done.sessionId if none was seen. */
export async function* runOnBridge(
  userId: string,
  bridgeName: string,
  req: {
    sessionId: string | null; prompt: string; model?: string | null; effort?: string | null;
    /** working folder for a NEW session (plugin >= 0.9.0 checks it against its known workspaces) */
    cwd?: string | null;
    context?: { conversationId: string; assistantMessageId: string | null; projectId: string | null };
  },
  signal?: AbortSignal,
): AsyncIterable<DshEvent> {
  const k = key(userId, bridgeName);
  const b = bridges.get(k);
  if (!b || b.ws.readyState !== b.ws.OPEN) throw new Error(offlineError(bridgeName));
  if (signal?.aborted) throw new Error("aborted");

  const runId = randomUUID();
  const queue: Item[] = [];
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const ctx: RunCtx | undefined = req.context
    ? { userId, conversationId: req.context.conversationId, assistantMessageId: req.context.assistantMessageId, projectId: req.context.projectId }
    : undefined;
  b.runs.set(runId, { push(i) { queue.push(i); poke(); }, ctx });

  let finished = false;
  const send = (o: unknown) => { if (b.ws.readyState === b.ws.OPEN) b.ws.send(JSON.stringify(o)); };
  const onAbort = () => {
    send({ type: "cancel", runId });
    queue.push({ fail: new Error("aborted") });
    poke();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    send({ type: "run", runId, sessionId: req.sessionId, prompt: req.prompt, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(!req.sessionId && req.cwd && b.workspacesSupported ? { cwd: req.cwd } : {}) });
    let sawSession = false;
    for (;;) {
      while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      const item = queue.shift()!;
      if (item.fail) { finished = true; throw item.fail; }
      if (item.event) {
        if (item.event.type === "session") sawSession = true;
        yield item.event;
      } else if (item.done) {
        finished = true;
        if (!item.done.ok) throw new Error(item.done.error || "Run failed");
        if (!sawSession && item.done.sessionId) yield { type: "session", sessionId: item.done.sessionId };
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) send({ type: "cancel", runId }); // consumer stopped early
    b.runs.delete(runId);
  }
}

/** Close bridge sockets authenticated with a revoked device (code 4001). */
export function closeDeviceBridges(userId: string, deviceId: string): void {
  closeVscodeDeviceBridges(userId, deviceId);
  for (const b of [...bridges.values()]) {
    if (b.userId === userId && b.deviceId === deviceId) { try { b.ws.close(4001, "device revoked"); } catch { /* ignore */ } }
  }
}

/** v4: asks the named bridge to restore a checkpoint (PROTOCOL-v4 section 6). Resolves on {type:"rewound"}, 60 s timeout, or disconnect. */
export function requestRewind(userId: string, bridgeName: string, ref: string, cwd: string, removeNew: boolean): Promise<{ ok: boolean; error?: string }> {
  const k = key(userId, bridgeName);
  const b = bridges.get(k);
  if (!b || b.ws.readyState !== b.ws.OPEN) return Promise.resolve({ ok: false, error: offlineError(bridgeName) });
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { settleRewind(requestId, null, { ok: false, error: "bridge did not answer" }); }, 60_000);
    rewinds.set(requestId, { bridgeKey: k, timer, resolve });
    try {
      b.ws.send(JSON.stringify({ type: "rewind", requestId, ref, cwd, ...(removeNew ? { removeNew: true } : {}) }));
    } catch {
      settleRewind(requestId, null, { ok: false, error: "bridge did not answer" });
    }
  });
}

/** Connection state of one of the user's bridges, for the Code preview (no secrets, no paths). */
export function bridgeState(userId: string, name: string): { online: boolean; cwd: string; fs: boolean } {
  const b = bridges.get(key(userId, name));
  if (!b || b.ws.readyState !== b.ws.OPEN) return { online: false, cwd: "", fs: false };
  return { online: true, cwd: b.cwd, fs: b.capabilities.fs === true };
}

/** Preview file access: asks the named bridge to list a directory or read a file under its working folder (docs/design/CODE-PREVIEW.md).
 *  Never sends to a bridge that did not report `capabilities.fs`. Resolves on `fs_result`, 10 s timeout (OMNICHAT_FS_TIMEOUT_MS), or disconnect. */
export function requestFs(
  userId: string,
  bridgeName: string,
  req: { cwd: string; op: "list" | "read"; path: string; maxBytes?: number },
): Promise<FsResult> {
  const k = key(userId, bridgeName);
  const b = bridges.get(k);
  if (!b || b.ws.readyState !== b.ws.OPEN) return Promise.resolve({ ok: false, error: offlineError(bridgeName), code: "bridge_offline" });
  if (b.capabilities.fs !== true) return Promise.resolve({ ok: false, error: "preview is disabled on this bridge", code: "preview_unavailable" });
  const requestId = randomUUID();
  const envMs = Number(process.env.OMNICHAT_FS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(envMs) && envMs > 0 ? envMs : 10_000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { settleFs(requestId, null, { ok: false, error: "bridge did not answer", code: "timeout" }); }, timeoutMs);
    fsRequests.set(requestId, { bridgeKey: k, timer, resolve });
    try {
      b.ws.send(JSON.stringify({ type: "fs", requestId, cwd: req.cwd, op: req.op, path: req.path, ...(req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {}) }));
    } catch {
      settleFs(requestId, null, { ok: false, error: "bridge did not answer", code: "timeout" });
    }
  });
}
