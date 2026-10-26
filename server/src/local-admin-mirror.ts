// /local-admin/{attachments,plugins,quotas}/* for the server app (loopback + local-admin token, see local-admin.ts).
// These forward to the equivalent /admin/* routes inside this process, acting as the first administrator through one
// internal device ("local-admin (server app)"), so both entrances share one implementation and one set of rules.
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { createDevice } from "./auth.js";
import { requireLocal } from "./local-admin.js";

const DEVICE_NAME = "local-admin (server app)";
let cached: { token: string; adminId: string } | null = null;

function adminToken(): string | null {
  const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1 AND disabled_at IS NULL ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined
    ?? db.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
  if (!admin) return null;
  if (cached && cached.adminId === admin.id) {
    const ok = db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND name = ? AND revoked_at IS NULL").get(admin.id, DEVICE_NAME);
    if (ok) return cached.token;
  }
  try { db.prepare("DELETE FROM devices WHERE name = ?").run(DEVICE_NAME); } catch { /* ignore */ }
  const d = createDevice(admin.id, DEVICE_NAME, "local-admin");
  cached = { token: d.token, adminId: admin.id };
  return d.token;
}

const MAP = /^\/local-admin\/(attachments|plugins|quotas|usage)(\/.*)?$/;

// /local-admin/voice/*: the same as /voice/admin/* (plus the status, the diagnose, and deleting a model via /voice/voices/models/:uuid).
const VOICE_ROUTES: [string, string][] = [
  ["GET", "status"], ["GET", "diagnose"], ["GET", "config"], ["PUT", "config"], ["GET", "llm"], ["PUT", "llm/roles"],
  ["GET", "users"], ["GET", "usage"], ["PUT", "quota"], ["GET", "placement"], ["PUT", "placement/stt"], ["GET", "models"], ["DELETE", "models/:uuid"],
];
// Paths that are not under /voice/admin/.
const VOICE_DIRECT: Record<string, string> = { status: "/voice/status", diagnose: "/voice/diagnose" };

const voiceHandler = async (app: FastifyInstance, req: any, reply: any) => {
  requireLocal(req);
  const url: string = req.raw.url ?? req.url;
  const q = url.indexOf("?");
  const pathname = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  const rest = pathname.slice("/local-admin/voice/".length);
  // DELETE models/:uuid is the model's own route; everything else is the admin side unless listed in VOICE_DIRECT.
  const target = VOICE_DIRECT[rest] ?? (req.method === "DELETE" ? `/voice/voices/${rest}` : `/voice/admin/${rest}`);
  const token = adminToken();
  if (!token) { reply.code(409); return { error: "no administrator account exists", code: "no_admin" }; }
  const res = await app.inject({
    method: req.method,
    url: target + query,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(req.body !== undefined && req.method !== "GET" && req.method !== "DELETE" ? { payload: JSON.stringify(req.body) } : {}),
  });
  reply.code(res.statusCode);
  const ct = res.headers["content-type"];
  if (ct) reply.header("content-type", ct);
  return res.body;
};

export function registerLocalAdminMirror(app: FastifyInstance): void {
  for (const [method, path] of VOICE_ROUTES) {
    app.route({ method: method as "GET" | "PUT" | "DELETE", url: `/local-admin/voice/${path}`, handler: (req: any, reply: any) => voiceHandler(app, req, reply) });
  }

  const handler = async (req: any, reply: any) => {
    requireLocal(req);
    const url: string = req.raw.url ?? req.url;
    const m = MAP.exec(url.split("?")[0]);
    if (!m) { reply.code(404); return { error: "not found" }; }
    const token = adminToken();
    if (!token) { reply.code(409); return { error: "no administrator account exists", code: "no_admin" }; }
    const res = await app.inject({
      method: req.method,
      url: url.startsWith("/local-admin/usage/") ? url.replace("/local-admin/usage/", "/usage/") : url.replace("/local-admin/", "/admin/"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(req.body !== undefined && req.method !== "GET" && req.method !== "DELETE" ? { payload: JSON.stringify(req.body) } : {}),
    });
    reply.code(res.statusCode);
    const ct = res.headers["content-type"];
    if (ct) reply.header("content-type", ct);
    return res.body;
  };
  app.route({ method: "GET", url: "/local-admin/usage/users", handler });
  app.route({ method: "GET", url: "/local-admin/usage/daily", handler });
  for (const path of ["attachments", "plugins", "plugins/inspect", "plugins/install", "plugins/:id", "plugins/:id/check-update", "quotas", "quotas/users", "quotas/users/:userId"]) {
    for (const method of ["GET", "PUT", "POST", "PATCH", "DELETE"] as const) {
      if (method === "GET" && !["attachments", "plugins", "quotas", "quotas/users"].includes(path)) continue;
      if (method === "PUT" && !["attachments", "quotas", "quotas/users/:userId"].includes(path)) continue;
      if (method === "POST" && !["plugins/inspect", "plugins/install", "plugins/:id/check-update"].includes(path)) continue;
      if (method === "PATCH" && path !== "plugins/:id") continue;
      if (method === "DELETE" && !["plugins/:id", "quotas/users/:userId"].includes(path)) continue;
      app.route({ method, url: `/local-admin/${path}`, handler });
    }
  }
}
