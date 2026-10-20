/* Admin HTTP API (PROTOCOL-v7-admin.md). Every handler is admin-only via requireAdminUser; mutations are rate limited. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "./auth.js";
import { requireAdminUser, checkRate, getGeneral, updateGeneral, listAudit, recordAudit } from "./admin-core.js";
import { readMaintenance, writeMaintenance, MAINTENANCE_MAX_MESSAGE, type MaintenancePatch } from "./maintenance.js";
import { broadcastAll } from "./hub.js";
import { PROVIDERS_CHANGED_FRAME } from "./shared-providers.js";
import { adminListUsers, adminCreateUser, adminPatchUser, adminResetPassword, adminRevoke, adminDeleteUser } from "./admin-users.js";
import { adminOverview, adminNetwork, adminLogs, scheduleRestart } from "./admin-info.js";
import { db, nextSeq, getProviderRow, toProvider } from "./db.js";
import { broadcast } from "./hub.js";
import { readGeneral } from "./server-general.js";
import { readAttachmentSettings, updateAttachments } from "./attachments-settings.js";
import {
  getGrant, setGrant, deleteGrant, grantsOfUser, normalizeModels, userExists, listAllSharedProviders, type GrantMode,
} from "./shared-providers.js";

/** Path parameter: non-empty string, at most 64 characters. */
function idParam(req: FastifyRequest, name: string, key: string): string {
  const id = (req.params as Record<string, unknown>)[key];
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new AuthError(`invalid ${name}`, 400);
  return id;
}

/** A JSON object body (400 otherwise) whose keys are all in `allowed`. */
function strictBody(body: unknown, allowed: string[]): Record<string, unknown> {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new AuthError(`unknown field: ${k}`, 400);
  return b;
}

/** :id path parameter: non-empty string, at most 64 characters. */
function userIdParam(req: FastifyRequest): string {
  const id = (req.params as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new AuthError("invalid user id", 400);
  return id;
}

/** ?limit=1..200 (default 50); anything else is a 400. */
function auditLimit(query: unknown): number {
  const raw = (query as { limit?: unknown } | undefined)?.limit;
  if (raw === undefined) return 50;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new AuthError("limit must be an integer from 1 to 200", 400);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 200) throw new AuthError("limit must be an integer from 1 to 200", 400);
  return n;
}

/** PUT /admin/maintenance body: partial and strict (400 on any problem), like updateGeneral. */
function maintenancePatch(body: unknown): MaintenancePatch {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) throw new AuthError("empty body", 400);
  const patch: MaintenancePatch = {};
  for (const k of keys) {
    const v = b[k];
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new AuthError("enabled must be a boolean", 400);
      patch.enabled = v;
    } else if (k === "message") {
      if (typeof v !== "string" || [...v].length > MAINTENANCE_MAX_MESSAGE) {
        throw new AuthError(`message must be a string of at most ${MAINTENANCE_MAX_MESSAGE} characters`, 400);
      }
      patch.message = v;
    } else if (k === "eta") {
      if (v !== null && !(Number.isSafeInteger(v) && (v as number) > 0)) throw new AuthError("eta must be null or a positive integer (epoch ms)", 400);
      patch.eta = v as number | null;
    } else {
      throw new AuthError(`unknown field: ${k}`, 400);
    }
  }
  return patch;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // public (no auth): the login screen shows it too
  app.get("/maintenance", async () => ({ maintenance: readMaintenance() }));

  app.put("/admin/maintenance", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const patch = maintenancePatch(req.body);
    const before = readMaintenance();
    const after = writeMaintenance(patch);
    if (after.updatedAt !== before.updatedAt) {
      for (const k of ["enabled", "message", "eta"] as const) {
        if (before[k] !== after[k]) recordAudit(a.actor, "maintenance.update", k, before[k], after[k]);
      }
      broadcastAll({ type: "maintenance", maintenance: after });
    }
    return { maintenance: after };
  });

  app.get("/admin/overview", async (req) => {
    requireAdminUser(req);
    return adminOverview();
  });

  app.get("/admin/attachments", async (req) => {
    requireAdminUser(req);
    return { attachments: readAttachmentSettings() };
  });

  app.put("/admin/attachments", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    return { attachments: updateAttachments(a.actor, req.body) };
  });

  app.get("/admin/settings", async (req) => {
    requireAdminUser(req);
    return { general: getGeneral() };
  });

  app.put("/admin/settings", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const general = updateGeneral(a.actor, req.body);
    broadcastAll(PROVIDERS_CHANGED_FRAME); // defaultSharedAccess may have changed for every user
    return { general };
  });

  app.get("/admin/users", async (req) => {
    const a = requireAdminUser(req);
    return adminListUsers(a.userId);
  });

  app.post("/admin/users", async (req, reply) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    checkRate(a.userId, "sensitive");
    const created = await adminCreateUser(a.actor, req.body);
    return reply.code(201).send(created);
  });

  app.patch("/admin/users/:id", async (req) => {
    const a = requireAdminUser(req);
    const id = userIdParam(req);
    checkRate(a.userId, "mutation");
    adminPatchUser(a.actor, id, req.body);
    return { ok: true };
  });

  app.post("/admin/users/:id/password", async (req) => {
    const a = requireAdminUser(req);
    const id = userIdParam(req);
    checkRate(a.userId, "mutation");
    checkRate(a.userId, "sensitive");
    const r = await adminResetPassword(a.actor, a.deviceId, id, req.body);
    return { ok: true, revokedDevices: r.revokedDevices };
  });

  app.post("/admin/users/:id/revoke", async (req) => {
    const a = requireAdminUser(req);
    const id = userIdParam(req);
    checkRate(a.userId, "mutation");
    const r = adminRevoke(a.actor, a.deviceId, id);
    return { ok: true, revokedDevices: r.revokedDevices, revokedKeys: r.revokedKeys };
  });

  app.delete("/admin/users/:id", async (req) => {
    const a = requireAdminUser(req);
    const id = userIdParam(req);
    checkRate(a.userId, "mutation");
    checkRate(a.userId, "sensitive");
    const body = req.body ?? {};
    const r = adminDeleteUser(a.actor, id, body);
    return { ok: true, mode: r.mode };
  });

  app.get("/admin/network", async (req) => {
    requireAdminUser(req);
    return adminNetwork();
  });

  app.post("/admin/restart", async (req, reply) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    checkRate(a.userId, "sensitive");
    const r = scheduleRestart(req.body);
    recordAudit(a.actor, "server.restart", "server", null, r.mode);
    return reply.code(202).send({ ok: true, mode: r.mode });
  });

  app.get("/admin/logs", async (req) => {
    requireAdminUser(req);
    const q = (req.query ?? {}) as { level?: unknown; lines?: unknown };
    return { lines: adminLogs(q.level, q.lines) };
  });

  app.get("/admin/audit", async (req) => {
    requireAdminUser(req);
    return { entries: listAudit(auditLimit(req.query)) };
  });

  // shared providers and per-user model grants (docs/PROTOCOL-v7-shared-providers.md)
  app.put("/admin/providers/:id/shared", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const id = idParam(req, "provider id", "id");
    const b = strictBody(req.body, ["shared"]);
    if (typeof b.shared !== "boolean") throw new AuthError("shared must be a boolean", 400);
    const row = getProviderRow(id);
    if (!row || row.deleted || row.user_id !== a.userId) throw new AuthError("Provider not found", 404);
    if (row.kind === "dsh-bridge") throw new AuthError("A dsh-bridge provider cannot be shared", 400);
    const before = !!row.shared;
    if (before !== b.shared) {
      db.prepare("UPDATE providers SET shared = ?, seq = ? WHERE id = ?").run(b.shared ? 1 : 0, nextSeq(), id);
      recordAudit(a.actor, "provider.shared", `shared:${id}`, before, b.shared);
      broadcast(a.userId, { type: "upsert", providers: [toProvider(getProviderRow(id))] });
      broadcastAll(PROVIDERS_CHANGED_FRAME); // every user's /sync list may change
    }
    return { id, shared: b.shared };
  });

  app.get("/admin/shared-providers", async (req) => {
    requireAdminUser(req);
    return { providers: listAllSharedProviders() };
  });

  app.get("/admin/users/:id/grants", async (req) => {
    requireAdminUser(req);
    const uid = userIdParam(req);
    if (!userExists(uid)) throw new AuthError("User not found", 404);
    return { defaultSharedAccess: readGeneral().defaultSharedAccess, grants: grantsOfUser(uid) };
  });

  app.put("/admin/users/:id/grants/:providerId", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const uid = userIdParam(req);
    const pid = idParam(req, "provider id", "providerId");
    const b = strictBody(req.body, ["mode", "models"]);
    const mode = b.mode;
    if (mode !== "all" && mode !== "list" && mode !== "none") throw new AuthError("mode must be all, list or none", 400);
    if (mode === "list" && !Array.isArray(b.models)) throw new AuthError("models is required (an array) when mode is list", 400);
    let models: string[] = [];
    try {
      if (b.models !== undefined) models = normalizeModels(b.models);
      if (mode === "list" && models.length === 0) throw new RangeError("models must not be empty when mode is list");
    } catch (e) {
      throw new AuthError((e as Error).message, 400);
    }
    if (!userExists(uid)) throw new AuthError("User not found", 404);
    const prov = getProviderRow(pid);
    if (!prov || prov.deleted || !prov.shared) throw new AuthError("Shared provider not found", 404);
    const before = getGrant(uid, pid);
    setGrant(uid, pid, mode as GrantMode, models);
    broadcast(uid, PROVIDERS_CHANGED_FRAME);
    const after = getGrant(uid, pid);
    recordAudit(a.actor, "grant.update", `grant:${uid}:${pid}`, before, after);
    return { providerId: pid, mode: after?.mode ?? mode, models: after?.models ?? [] };
  });

  app.delete("/admin/users/:id/grants/:providerId", async (req) => {
    const a = requireAdminUser(req);
    checkRate(a.userId, "mutation");
    const uid = userIdParam(req);
    const pid = idParam(req, "provider id", "providerId");
    if (!userExists(uid)) throw new AuthError("User not found", 404);
    const before = getGrant(uid, pid);
    const removed = deleteGrant(uid, pid);
    if (removed) broadcast(uid, PROVIDERS_CHANGED_FRAME);
    if (removed) recordAudit(a.actor, "grant.delete", `grant:${uid}:${pid}`, before, null);
    return { ok: true, removed };
  });
}
