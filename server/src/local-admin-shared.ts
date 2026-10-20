// Shared providers and per-user model grants for the server app (loopback + local-admin token, see local-admin.ts).
// Same contract and validation as the admin API in routes-admin.ts (docs/PROTOCOL-v7-shared-providers.md),
// with the same audit rows. Local calls have no user account behind them, so the audit rows name this actor.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "./auth.js";
import { recordAudit, updateGeneral, getGeneral } from "./admin-core.js";
import { db, nextSeq, getProviderRow } from "./db.js";
import { broadcastAll } from "./hub.js";
import { modelsForProvider } from "./models.js";
import { requireLocal } from "./local-admin.js";
import {
  getGrant, setGrant, deleteGrant, grantsOfUser, normalizeModels, userExists, listAllSharedProviders, isAdminUser,
  type GrantMode,
} from "./shared-providers.js";

const LOCAL_ACTOR = { id: "local-admin", name: "local-admin" };

/** Body must be a plain JSON object with only the listed keys (400 otherwise). Empty bodies are refused too. */
function strictBody(body: unknown, allowed: string[]): Record<string, unknown> {
  const proto = body && typeof body === "object" ? Object.getPrototypeOf(body) : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || (proto !== Object.prototype && proto !== null)) {
    throw new AuthError("body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) throw new AuthError("empty body", 400);
  for (const k of keys) if (!allowed.includes(k)) throw new AuthError(`unknown field: ${k}`, 400);
  return b;
}

/** Path parameter: non-empty string, at most 64 characters (same as routes-admin.ts). */
function param(req: FastifyRequest, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new AuthError(`invalid ${name}`, 400);
  return v;
}

const flag = (v: unknown): boolean => v === true || v === "1" || v === "true";

export function registerLocalAdminShared(app: FastifyInstance): void {
  // PUT /local-admin/providers/:id/shared  { shared: boolean }  (admin-owned providers only)
  app.put("/local-admin/providers/:id/shared", async (req) => {
    requireLocal(req);
    const id = param(req, "id");
    const b = strictBody(req.body, ["shared"]);
    if (typeof b.shared !== "boolean") throw new AuthError("shared must be a boolean", 400);
    const row = getProviderRow(id);
    if (!row || row.deleted || !isAdminUser(row.user_id)) throw new AuthError("Provider not found", 404);
    if (row.kind === "dsh-bridge") throw new AuthError("A dsh-bridge provider cannot be shared", 400);
    const before = !!row.shared;
    if (before !== b.shared) {
      db.prepare("UPDATE providers SET shared = ?, seq = ? WHERE id = ?").run(b.shared ? 1 : 0, nextSeq(), id);
      recordAudit(LOCAL_ACTOR, "provider.shared", `shared:${id}`, before, b.shared);
      broadcastAll({ type: "providers-changed" });
    }
    return { id, shared: b.shared };
  });

  // GET /local-admin/shared-providers
  app.get("/local-admin/shared-providers", async (req) => {
    requireLocal(req);
    return { providers: listAllSharedProviders() };
  });

  // GET /local-admin/providers/:id/models?refresh=1&all=1  (the owner's model list, same as GET /providers/:id/models)
  app.get("/local-admin/providers/:id/models", async (req) => {
    requireLocal(req);
    const row = getProviderRow(param(req, "id"));
    if (!row || row.deleted) throw new AuthError("Provider not found", 404);
    const q = (req.query ?? {}) as Record<string, unknown>;
    return modelsForProvider(row, flag(q.refresh), flag(q.all));
  });

  // GET /local-admin/users/:id/grants
  app.get("/local-admin/users/:id/grants", async (req) => {
    requireLocal(req);
    const uid = param(req, "id");
    if (!userExists(uid)) throw new AuthError("User not found", 404);
    return { defaultSharedAccess: getGeneral().defaultSharedAccess, grants: grantsOfUser(uid) };
  });

  // PUT /local-admin/users/:id/grants/:providerId  { mode: "all" | "list" | "none", models?: string[] }
  app.put("/local-admin/users/:id/grants/:providerId", async (req) => {
    requireLocal(req);
    const uid = param(req, "id");
    const pid = param(req, "providerId");
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
    const after = getGrant(uid, pid);
    recordAudit(LOCAL_ACTOR, "grant.update", `grant:${uid}:${pid}`, before, after);
    broadcastAll({ type: "providers-changed" });
    return { providerId: pid, mode: after?.mode ?? mode, models: after?.models ?? [] };
  });

  // DELETE /local-admin/users/:id/grants/:providerId  (removing the row restores the default)
  app.delete("/local-admin/users/:id/grants/:providerId", async (req) => {
    requireLocal(req);
    const uid = param(req, "id");
    const pid = param(req, "providerId");
    if (!userExists(uid)) throw new AuthError("User not found", 404);
    const before = getGrant(uid, pid);
    const removed = deleteGrant(uid, pid);
    if (removed) {
      recordAudit(LOCAL_ACTOR, "grant.delete", `grant:${uid}:${pid}`, before, null);
      broadcastAll({ type: "providers-changed" });
    }
    return { ok: true, removed };
  });

  // GET /local-admin/shared-settings
  app.get("/local-admin/shared-settings", async (req) => {
    requireLocal(req);
    const g = getGeneral();
    return { defaultSharedAccess: g.defaultSharedAccess, allowOwnProviders: g.allowOwnProviders };
  });

  // PUT /local-admin/shared-settings  { defaultSharedAccess?, allowOwnProviders? }
  // Validation and audit (settings.update) are the ones of PUT /admin/settings (admin-core.ts updateGeneral).
  app.put("/local-admin/shared-settings", async (req) => {
    requireLocal(req);
    const b = strictBody(req.body, ["defaultSharedAccess", "allowOwnProviders"]);
    const g = updateGeneral(LOCAL_ACTOR, b);
    broadcastAll({ type: "providers-changed" });
    return { defaultSharedAccess: g.defaultSharedAccess, allowOwnProviders: g.allowOwnProviders };
  });
}
