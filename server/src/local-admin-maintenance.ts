// Maintenance mode for the server app (loopback + local-admin token, see local-admin.ts).
// Same contract and validation as PUT /admin/maintenance (routes-admin.ts), with the same audit rows and broadcast.
import type { FastifyInstance } from "fastify";
import { AuthError } from "./auth.js";
import { recordAudit } from "./admin-core.js";
import { readMaintenance, writeMaintenance, MAINTENANCE_MAX_MESSAGE, type MaintenancePatch } from "./maintenance.js";
import { broadcastAll } from "./hub.js";
import { requireLocal } from "./local-admin.js";

// the local API has no user account behind it, so the audit rows name this actor
const LOCAL_ACTOR = { id: "local-admin", name: "local-admin" };

/** Body of PUT /local-admin/maintenance: partial and strict (400 on any problem), like PUT /admin/maintenance.
 *  eta: null clears it. Passing clearEta: true has the same effect as eta: null (the server app sends it that way). */
function localMaintenancePatch(body: unknown): MaintenancePatch {
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
    } else if (k === "clearEta") {
      if (typeof v !== "boolean") throw new AuthError("clearEta must be a boolean", 400);
      if (v) patch.eta = null;
    } else {
      throw new AuthError(`unknown field: ${k}`, 400);
    }
  }
  return patch;
}

export function registerLocalAdminMaintenance(app: FastifyInstance): void {
  app.get("/local-admin/maintenance", async (req) => {
    requireLocal(req);
    return { maintenance: readMaintenance() };
  });
  app.put("/local-admin/maintenance", async (req) => {
    requireLocal(req);
    const patch = localMaintenancePatch(req.body);
    const before = readMaintenance();
    const after = writeMaintenance(patch);
    if (after.updatedAt !== before.updatedAt) {
      for (const k of ["enabled", "message", "eta"] as const) {
        if (before[k] !== after[k]) recordAudit(LOCAL_ACTOR, "maintenance.update", k, before[k], after[k]);
      }
      broadcastAll({ type: "maintenance", maintenance: after });
    }
    return { maintenance: after };
  });
}
