import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { listTools, reloadPlugins, toolsReady } from "./tools/registry.js";
import { listGrants, deleteGrant } from "./tools/approvals.js";
import { searchStatus } from "./search/index.js";
import { publicSearchConfig, updateSearchConfig } from "./search/config.js";
import { runSearchTest } from "./search-test.js";
import { TOOL_NAME_RE } from "./tools/types.js";
import { actorOf, recordAudit } from "./admin-core.js";

const isAdmin = (userId: string): boolean => !!(db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as any)?.is_admin;
function adminOnly(req: { headers: Record<string, any> }): string {
  const userId = authFromRequest(req).userId;
  if (!isAdmin(userId)) throw new AuthError("Admin only", 403);
  return userId;
}

export function registerToolRoutes(app: FastifyInstance): void {
  void reloadPlugins().catch((e) => console.error("plugin load failed", e));

  app.get("/tools", async (req) => {
    authFromRequest(req);
    await toolsReady();
    return { tools: listTools() };
  });
  app.post("/tools/reload", async (req) => {
    adminOnly(req);
    await reloadPlugins();
    return { tools: listTools() };
  });

  app.get("/tool-grants", async (req) => ({ grants: listGrants(authFromRequest(req).userId) }));
  app.delete("/tool-grants/:tool", async (req) => {
    const userId = authFromRequest(req).userId;
    const tool = (req.params as any).tool as string;
    if (!TOOL_NAME_RE.test(tool)) throw new AuthError("Unknown tool", 400);
    deleteGrant(userId, tool);
    return { ok: true };
  });

  app.get("/search/status", async (req) => {
    authFromRequest(req);
    return await searchStatus();
  });
  app.get("/search/config", async (req) => {
    authFromRequest(req);
    return publicSearchConfig(false);
  });
  app.put("/search/config", async (req) => {
    const userId = adminOnly(req);
    updateSearchConfig(req.body);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    for (const k of Object.keys(body)) recordAudit(actorOf(userId), "search.config", k, undefined, body[k]);
    return publicSearchConfig(false);
  });
  app.post("/search/test", async (req, reply) => {
    adminOnly(req);
    const r = await runSearchTest(req.body);
    reply.code(r.status);
    return r.body;
  });
}
