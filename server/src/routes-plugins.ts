import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import {
  checkUpdate, deletePlugin, installInspection, inspectGithub, inspectionResponse, listPlugins, PluginError, setEnabled,
} from "./plugin-install.js";

/* Admin plugin install routes (docs/PROTOCOL-v7-plugins.md). Errors: { error, code }. */

const isAdmin = (userId: string): boolean => !!(db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as any)?.is_admin;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function adminUser(req: FastifyRequest): string {
  const userId = authFromRequest(req).userId;
  if (!isAdmin(userId)) throw new AuthError("Admin only", 403);
  return userId;
}

/** Runs a route body; maps our errors (and auth errors) to { error, code } with the right status. */
async function respond(req: FastifyRequest, reply: FastifyReply, fn: (userId: string) => Promise<unknown>): Promise<unknown> {
  try {
    return await fn(adminUser(req));
  } catch (e: any) {
    if (e instanceof PluginError) {
      reply.code(e.status);
      return { error: e.message, code: e.code };
    }
    if (e instanceof AuthError) {
      reply.code(e.status);
      return { error: e.message, code: e.status === 403 ? "forbidden" : e.status === 401 ? "unauthorized" : "bad_request" };
    }
    throw e;
  }
}

const bodyOf = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

export function registerPluginRoutes(app: FastifyInstance): void {
  app.get("/admin/plugins", async (req, reply) => respond(req, reply, async () => ({ plugins: await listPlugins() })));

  app.post("/admin/plugins/inspect", async (req, reply) => respond(req, reply, async (userId) => {
    const b = bodyOf(req);
    if (b.source !== "github") throw new PluginError("bad_source", "source は github のみです", 400);
    const insp = await inspectGithub(userId, b);
    return inspectionResponse(insp);
  }));

  app.post("/admin/plugins/install", async (req, reply) => respond(req, reply, async (userId) => {
    const b = bodyOf(req);
    if (typeof b.inspectionId !== "string" || typeof b.confirmId !== "string") {
      throw new PluginError("bad_request", "inspectionId と confirmId が必要です", 400);
    }
    return { plugin: await installInspection(userId, b.inspectionId, b.confirmId) };
  }));

  app.patch("/admin/plugins/:id", async (req, reply) => respond(req, reply, async (userId) => {
    const id = (req.params as any).id as string;
    if (!ID_RE.test(id)) throw new PluginError("not_found", "プラグインが見つかりません", 404);
    const b = bodyOf(req);
    if (typeof b.enabled !== "boolean") throw new PluginError("bad_request", "enabled は true か false です", 400);
    return { plugin: await setEnabled(userId, id, b.enabled) };
  }));

  app.delete("/admin/plugins/:id", async (req, reply) => respond(req, reply, async (userId) => {
    const id = (req.params as any).id as string;
    if (!ID_RE.test(id)) throw new PluginError("not_found", "プラグインが見つかりません", 404);
    await deletePlugin(userId, id);
    return { ok: true };
  }));

  app.post("/admin/plugins/:id/check-update", async (req, reply) => respond(req, reply, async (userId) => {
    const id = (req.params as any).id as string;
    if (!ID_RE.test(id)) throw new PluginError("not_found", "プラグインが見つかりません", 404);
    const r = await checkUpdate(userId, id);
    if (!r.updateAvailable || !r.inspection) return { updateAvailable: false, latestCommitSha: r.latestCommitSha };
    return { updateAvailable: true, latestCommitSha: r.latestCommitSha, ...inspectionResponse(r.inspection), diff: r.diff };
  }));
}
