// Loopback-only administration API for the OmniChat server app (and scripts on the same machine).
//
// Authority = being able to read DATA_DIR/local-admin.token (mode 0600, regenerated on every start) AND connecting from
// the loopback interface. It is not reachable through a reverse proxy or a published Docker port (the peer address
// would not be loopback), and no HTTP login can reach it.
import { hasForwardingHeaders } from "./route.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DATA_DIR, HOST, PORT } from "./config.js";
import { registrationAllowed } from "./server-general.js";
import { AuthError, createUserDirect, setPassword } from "./auth.js";
import { db } from "./db.js";
import { listUsers, setDisabled, setRole, userExists } from "./users-admin.js";
import { publicSearchConfig, updateSearchConfig } from "./search/config.js";
import { searchStatus } from "./search/index.js";
import { runSearchTest } from "./search-test.js";
import { getUpdateService } from "./updater/service.js";
import { readVersionBody, sendUpdateError } from "./updater/routes.js";
import { registerLocalAdminOverview } from "./local-admin-overview.js";
import { registerLocalAdminMaintenance } from "./local-admin-maintenance.js";
import { registerLocalAdminShared } from "./local-admin-shared.js";
import { registerLocalAdminMirror } from "./local-admin-mirror.js";

export const LOCAL_ADMIN_TOKEN_FILE = join(DATA_DIR, "local-admin.token");
let token = "";

export function initLocalAdminToken(): void {
  token = randomBytes(32).toString("hex");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCAL_ADMIN_TOKEN_FILE, token + "\n", { mode: 0o600 });
  try { chmodSync(LOCAL_ADMIN_TOKEN_FILE, 0o600); } catch { /* best effort (Windows) */ }
}

const isLoopback = (a: string | undefined): boolean => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

export function requireLocal(req: FastifyRequest): void {
  // a reverse proxy running on this machine connects from loopback too, but it adds forwarding headers
  if (!isLoopback(req.socket.remoteAddress) || hasForwardingHeaders(req.headers)) throw new AuthError("Local administration is only available from the server machine", 403);
  const given = Buffer.from(String(req.headers["x-local-admin"] ?? ""));
  const want = Buffer.from(token);
  if (!token || given.length !== want.length || !timingSafeEqual(given, want)) throw new AuthError("Invalid local admin token", 401);
}

export function registerLocalAdminRoutes(app: FastifyInstance): void {
  registerLocalAdminOverview(app);
  registerLocalAdminMaintenance(app);
  registerLocalAdminShared(app);
  registerLocalAdminMirror(app);
  const started = Date.now();
  app.get("/local-admin/status", async (req) => {
    requireLocal(req);
    const c = db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
    return { ok: true, uptimeSec: Math.round((Date.now() - started) / 1000), port: PORT, host: HOST, users: Number(c.c), allowRegistration: registrationAllowed() };
  });
  app.get("/local-admin/update/status", async (req) => {
    requireLocal(req);
    return getUpdateService().status(true);
  });
  app.post("/local-admin/update/check", async (req, reply) => {
    requireLocal(req);
    try {
      return await getUpdateService().checkNow();
    } catch (e) {
      return sendUpdateError(reply, e);
    }
  });
  app.post("/local-admin/update/apply", async (req, reply) => {
    requireLocal(req);
    const version = readVersionBody(((req.body ?? {}) as any).version);
    try {
      const r = await getUpdateService().apply(version);
      return reply.code(202).send({ ok: true, phase: r.phase });
    } catch (e) {
      return sendUpdateError(reply, e);
    }
  });
  app.get("/local-admin/users", async (req) => { requireLocal(req); return { users: listUsers() }; });
  app.post("/local-admin/users", async (req) => {
    requireLocal(req);
    const b = (req.body ?? {}) as any;
    if (b.role !== "admin" && b.role !== "user") throw new AuthError("role must be 'admin' or 'user'");
    const u = await createUserDirect(b.username, b.password, b.role === "admin");
    return { id: u.userId, username: u.username, role: b.role };
  });
  app.patch("/local-admin/users/:id", async (req) => {
    requireLocal(req);
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    userExists(id);
    if (b.role !== undefined) setRole(id, b.role);
    if (b.disabled !== undefined) setDisabled(id, b.disabled);
    return { ok: true };
  });
  app.get("/local-admin/search/config", async (req) => {
    requireLocal(req);
    return { ...publicSearchConfig(true), status: await searchStatus() };
  });
  app.put("/local-admin/search/config", async (req) => {
    requireLocal(req);
    updateSearchConfig(req.body);
    return { ...publicSearchConfig(true), status: await searchStatus() };
  });
  app.post("/local-admin/search/test", async (req, reply) => {
    requireLocal(req);
    const r = await runSearchTest(req.body);
    reply.code(r.status);
    return r.body;
  });
  app.post("/local-admin/users/:id/password", async (req) => {
    requireLocal(req);
    const id = (req.params as any).id as string;
    userExists(id);
    await setPassword(id, ((req.body ?? {}) as any).password);
    return { ok: true };
  });
}
