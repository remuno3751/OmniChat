import type { FastifyInstance } from "fastify";
import { getConversationRow } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { measureContext } from "./context.js";
import { computeStats, metricsCsv } from "./metrics.js";

/** Phase 2 read-only endpoints: context usage and speed statistics. */
export function registerVisibilityRoutes(app: FastifyInstance): void {
  const ctxFor = async (userId: string, id: string, body: any) => {
    const conv = getConversationRow(id);
    if (!conv || conv.user_id !== userId || conv.deleted) throw new AuthError("Conversation not found", 404);
    const draft = typeof body?.draft === "string" ? body.draft.slice(0, 2_000_000) : undefined;
    const providerId = typeof body?.providerId === "string" && body.providerId ? body.providerId : null;
    const model = typeof body?.model === "string" && body.model ? body.model.slice(0, 300) : null;
    return (await measureContext({ userId, conv, draft, providerId, model })).usage;
  };

  app.get("/conversations/:id/context", async (req) => ctxFor(authFromRequest(req).userId, (req.params as any).id, {}));
  app.post("/conversations/:id/context", async (req) => ctxFor(authFromRequest(req).userId, (req.params as any).id, req.body));

  app.get("/stats", async (req) => {
    const userId = authFromRequest(req).userId;
    const q = req.query as any;
    const since = Number(q.since ?? 0) || 0;
    const rn = Number.parseInt(String(q.recent ?? "20"), 10);
    const recent = Number.isFinite(rn) && rn > 0 ? Math.min(rn, 1000) : 20;
    return computeStats(userId, since, recent);
  });

  app.get("/stats/export", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="omnichat-metrics.csv"')
      .send(metricsCsv(userId));
  });
}
