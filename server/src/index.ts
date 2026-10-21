import { isAgentBridgeKind, vscodeProviderRefusal } from "./agent-kinds.js";
import { installLogRing } from "./logring.js";
installLogRing();
import { initLocalAdminToken, registerLocalAdminRoutes } from "./local-admin.js";
import { encryptSecret } from "./secret.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer } from "ws";
import {
  db, nextSeq, currentSeq, toConversation, toMessage, toProvider,
  getConversationRow, getProviderRow,
} from "./db.js";
import { AuthError, register, login, deviceFromToken } from "./auth.js";
import { PORT, HOST, CORS_ORIGIN, TRUST_PROXY } from "./config.js";
import { classifyRoute, hasForwardingHeaders } from "./route.js";
import { noteRequestHeaders } from "./diagnostics.js";
import { registerVisibilityRoutes } from "./routes-visibility.js";
import { registerUsageRoutes } from "./routes-usage.js";
import { registerCompactRoutes } from "./routes-compact.js";
import { registerDevices } from "./devices.js";
import { registerApiKeys } from "./apikeys.js";
import { registerOpenAi } from "./openai-api.js";
import { registerStatic, webCsp } from "./static.js";
import { addConn, removeConn, broadcast, broadcastAll, sendTo } from "./hub.js";
import { handleChatFrame, sendSnapshot } from "./chat.js";
import { registerChatRoutes } from "./routes-chat.js";
import { registerSync } from "./sync.js";
import { handleBridgeUpgrade, listBridges } from "./bridges.js";
import "./vscode-chat.js";
import { providerKinds } from "./providers/index.js";
import { parseEffortProfile } from "./effort.js";
import { readGeneral } from "./server-general.js";
import { isAdminUser, removeProviderGrants, getUsableProviderRow, PROVIDERS_CHANGED_FRAME } from "./shared-providers.js";
import { modelsForUser, allModels, startModelPolling } from "./models.js";
import { localServers } from "./local-servers.js";
import { registerModelRoutes } from "./routes-models.js";
import { registerLogoRoutes } from "./routes-logos.js";
import { registerArtifactRoutes } from "./artifacts.js";
import { registerToolRoutes } from "./routes-tools.js";
import { registerPluginRoutes } from "./routes-plugins.js";
import { registerHistoryRoutes } from "./routes-history.js";
import { registerDevRoutes } from "./routes-dev.js";
import { registerV4Routes } from "./routes-v4.js";
import { registerCodePreviewRoutes } from "./routes-code-preview.js";
import { registerPreviewFrameRoute } from "./routes-preview-frame.js";
import { registerUpdateRoutes } from "./updater/routes.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerQuotaRoutes, startQuotaCleanup } from "./quota.js";
import { scrubOldBorrowerDebug } from "./debuglog.js";
import { registerAttachmentRoutes } from "./routes-attachments.js";
import { startRetentionJob, deleteAttachmentsOfConversation } from "./attachments-retention.js";
import { MaintenanceError, maintenanceRetryAfter, readMaintenance } from "./maintenance.js";
import { getUpdateService } from "./updater/service.js";
import { forbiddenOutboundUrl } from "./url-guard.js";
import {
  isEphemeralId, getEphemeral, destroyEphemeral, destroyEphemeralForUser,
  onEphemeralDeviceConnect, onEphemeralDeviceDisconnect, startEphemeralSweeper,
} from "./ephemeral.js";

// trustProxy only when the operator says a reverse proxy is in front: otherwise every client behind it shares one IP
// and the per-IP login throttle locks everybody out together. Only proxies on loopback / private addresses are trusted, and
// req.ip is the first untrusted hop from the right, so a client cannot pick its own limiter bucket by sending X-Forwarded-For.
const app = Fastify({ logger: false, trustProxy: TRUST_PROXY ? "loopback,linklocal,uniquelocal" : false });
await app.register(cors, { origin: CORS_ORIGIN.length ? CORS_ORIGIN : true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });

app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  try { done(null, body === "" ? {} : JSON.parse(body as string)); } catch (e: any) { e.statusCode = 400; done(e); }
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Baseline response headers; HTML pages (the web UI) get the full CSP, computed once from the real index.html.
let cspCache = "";
const csp = () => (cspCache ||= webCsp());
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  // the preview frame page is the one page meant to be framed (by the app itself): its CSP frame-ancestors says so. X-Frame-Options is
  // left off on purpose: a sandboxed frame has an opaque origin, so "SAMEORIGIN" would refuse to load it.
  if (!reply.hasHeader("X-Frame-Options") && !reply.hasHeader("X-Omnichat-Frameable")) reply.header("X-Frame-Options", "DENY");
  reply.removeHeader("X-Omnichat-Frameable");
  if (!reply.hasHeader("Content-Security-Policy")) {
    const isHtml = String(reply.getHeader("content-type") ?? "").startsWith("text/html");
    reply.header("Content-Security-Policy", isHtml ? csp() : "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  }
  return payload;
});

app.addHook("onRequest", async (req) => { noteRequestHeaders(req.headers); });

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof MaintenanceError) {
    const retry = maintenanceRetryAfter(err.maintenance);
    if (retry !== null) reply.header("Retry-After", String(retry));
    reply.status(503).send({ error: { type: "service_unavailable", code: "maintenance", message: err.message } });
    return;
  }
  const status = err instanceof AuthError || err instanceof HttpError ? err.status : err.statusCode ?? 500;
  const errCode = (err as { code?: unknown }).code;
  const code = err instanceof AuthError && typeof errCode === "string" ? { code: errCode } : {};
  reply.status(status).send({ error: err.message ?? "Internal error", ...code });
});

app.post("/auth/register", async (req) => {
  const b = (req.body ?? {}) as any;
  return register(b.username, b.password, b.deviceName, b.platform);
});
app.post("/auth/login", async (req) => {
  const b = (req.body ?? {}) as any;
  return login(b.username, b.password, b.deviceName, b.platform, req.ip);
});

function authUser(req: { headers: Record<string, any> }): string {
  const h = String(req.headers.authorization ?? "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const u = deviceFromToken(m?.[1]?.trim());
  if (!u) throw new HttpError(401, "Unauthorized");
  return u.userId;
}

const isRefresh = (req: { query: unknown }) => { const r = (req.query as any)?.refresh; return r === "1" || r === "true"; };
const isAll = (req: { query: unknown }) => { const r = (req.query as any)?.all; return r === "1" || r === "true"; };
const isStr = (v: unknown): v is string => typeof v === "string";

app.get("/provider-kinds", async (req) => {
  authUser(req);
  return { kinds: providerKinds() };
});

app.get("/bridges", async (req) => {
  const userId = authUser(req);
  return { bridges: listBridges(userId) };
});

app.get("/providers/:id/models", async (req) => {
  const userId = authUser(req);
  const row = getUsableProviderRow(userId, (req.params as any).id);
  if (!row || row.deleted) throw new HttpError(404, "Provider not found");
  return modelsForUser(userId, row, isRefresh(req), isAll(req));
});

app.get("/models", async (req) => {
  const userId = authUser(req);
  return allModels(userId, isRefresh(req), isAll(req));
});

app.get("/local-servers", async (req) => {
  const userId = authUser(req);
  return localServers(userId);
});

app.delete("/conversations/:id", async (req) => {
  const userId = authUser(req);
  const id = (req.params as any).id as string;
  if (isEphemeralId(id)) {
    const info = getEphemeral(id);
    if (info && info.userId !== userId) throw new HttpError(404, "Conversation not found");
    destroyEphemeral(id, "ended");
    return { ok: true, ephemeral: true };
  }
  const row = getConversationRow(id);
  if (!row || row.user_id !== userId) throw new HttpError(404, "Conversation not found");
  db.prepare("UPDATE conversations SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), id);
  try { deleteAttachmentsOfConversation(id); } catch (e) { console.error("attachment cleanup failed", e); }
  const conv = toConversation(getConversationRow(id));
  broadcast(userId, { type: "upsert", conversations: [conv] });
  return conv;
});

app.delete("/ephemeral", async (req) => {
  const userId = authUser(req);
  return { destroyed: destroyEphemeralForUser(userId, "ended") };
});

app.put("/providers/:id", async (req) => {
  const userId = authUser(req);
  const id = (req.params as any).id as string;
  const b = (req.body ?? {}) as any;
  if (!isStr(b.name) || !isStr(b.kind) || !isStr(b.baseUrl) || !isStr(b.model)) {
    throw new HttpError(400, "name, kind, baseUrl and model are required");
  }
  // dsh-bridge providers carry a bridge name, not a URL
  const bad = isAgentBridgeKind(b.kind) ? null : forbiddenOutboundUrl(b.baseUrl);
  if (bad) throw new HttpError(400, `baseUrl: ${bad}`);
  const vsBad = vscodeProviderRefusal(b.kind, b.baseUrl, b.apiKey);
  if (vsBad) throw new HttpError(400, vsBad);
  // effortProfile: absent = keep the stored value (new rows: standard); present = validated, "standard" stored as null
  const ep = b.effortProfile === undefined ? undefined : parseEffortProfile(b.effortProfile);
  if (ep && !ep.ok) throw new HttpError(400, "effortProfile must be one of standard, xhigh, think-toggle, none, or null");
  const row = getProviderRow(id);
  if (row && row.user_id !== userId) throw new HttpError(403, "Forbidden");
  if (row && Number(row.shared) === 1 && isAgentBridgeKind(b.kind)) throw new HttpError(400, `A shared provider cannot be a ${b.kind}`);
  // allowOwnProviders=false: ordinary users keep editing and deleting their providers, but cannot add one (or revive a deleted one)
  if ((!row || row.deleted) && !readGeneral().allowOwnProviders && !isAdminUser(userId)) {
    throw new HttpError(403, "Adding your own providers is disabled on this server");
  }
  const seq = nextSeq();
  if (!row) {
    const profile = ep && ep.ok ? ep.value : null;
    db.prepare(
      "INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq, effort_profile) VALUES (?,?,?,?,?,?,?,?,0,?,?)",
    ).run(id, userId, b.name, b.kind, b.baseUrl, b.model, isStr(b.apiKey) ? encryptSecret(b.apiKey) : "", Date.now(), seq, profile);
  } else {
    const apiKey = isStr(b.apiKey) ? encryptSecret(b.apiKey) : row.api_key;
    const profile = ep === undefined ? (row.effort_profile ?? null) : ep.ok ? ep.value : null;
    db.prepare("UPDATE providers SET name = ?, kind = ?, base_url = ?, model = ?, api_key = ?, deleted = 0, seq = ?, effort_profile = ? WHERE id = ?").run(b.name, b.kind, b.baseUrl, b.model, apiKey, seq, profile, id);
  }
  const p = toProvider(getProviderRow(id));
  broadcast(userId, { type: "upsert", providers: [p] });
  // other users see shared providers through /sync; tell them when this one changed (shared or was shared)
  if (p.shared || (row && Number(row.shared) === 1)) broadcastAll(PROVIDERS_CHANGED_FRAME);
  return p;
});

app.delete("/providers/:id", async (req) => {
  const userId = authUser(req);
  const id = (req.params as any).id as string;
  const row = getProviderRow(id);
  if (!row || row.user_id !== userId) throw new HttpError(404, "Provider not found");
  const wasShared = Number(row.shared) === 1;
  db.prepare("UPDATE providers SET deleted = 1, seq = ? WHERE id = ?").run(nextSeq(), id);
  removeProviderGrants(id);
  const p = toProvider(getProviderRow(id));
  broadcast(userId, { type: "upsert", providers: [p] });
  if (wasShared) broadcastAll(PROVIDERS_CHANGED_FRAME);
  return p;
});

// WebSocket on the same HTTP server.
// 4 MiB: far above any chat frame (REST bodies are capped at 1 MiB); ws would otherwise allow 100 MiB per message
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
app.server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/bridge") return handleBridgeUpgrade(req, socket, head, url);
  if (url.pathname !== "/ws") return socket.destroy();
  const user = deviceFromToken(url.searchParams.get("token"));
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const userId = user.userId;
    addConn(userId, ws, user.deviceId);
    onEphemeralDeviceConnect(userId, user.deviceId);
    sendTo(ws, {
      type: "hello", seq: currentSeq(), serverTime: Date.now(), maintenance: readMaintenance(), allowOwnProviders: readGeneral().allowOwnProviders,
      route: classifyRoute(req.socket.remoteAddress, req.headers["x-forwarded-for"], TRUST_PROXY, hasForwardingHeaders(req.headers)),
    });
    sendSnapshot(userId, ws);
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === "ping") { sendTo(ws, { type: "pong", t: msg.t }); return; }
      handleChatFrame(userId, ws, msg);
    });
    ws.on("close", () => { removeConn(userId, ws); onEphemeralDeviceDisconnect(userId, user.deviceId); });
    ws.on("error", () => { removeConn(userId, ws); onEphemeralDeviceDisconnect(userId, user.deviceId); });
  });
});

registerDevices(app);
registerApiKeys(app);
registerOpenAi(app);
await registerStatic(app);

// --- feature route modules (one line each) ---
registerSync(app);
registerChatRoutes(app);
registerModelRoutes(app);
registerLogoRoutes(app);
registerToolRoutes(app);
registerPluginRoutes(app);
registerVisibilityRoutes(app);
registerUsageRoutes(app);
registerCompactRoutes(app);
registerHistoryRoutes(app);
registerDevRoutes(app);
registerArtifactRoutes(app);
registerV4Routes(app);
registerCodePreviewRoutes(app);
registerPreviewFrameRoute(app);
registerUpdateRoutes(app);
registerAdminRoutes(app);
registerQuotaRoutes(app);
await registerAttachmentRoutes(app);
initLocalAdminToken();
registerLocalAdminRoutes(app);

startModelPolling();
startEphemeralSweeper();
startRetentionJob();
startQuotaCleanup();
try { const n = scrubOldBorrowerDebug(); if (n) console.log(`scrubbed ${n} old debug record(s) of borrowed providers`); } catch (e) { console.error("debug scrub failed", e); }
await app.listen({ port: PORT, host: HOST });
getUpdateService().start();
console.log(`OmniChat server listening on :${PORT}`);
