import type { FastifyInstance } from "fastify";
import { getProviderRow } from "./db.js";
import { getUsableProviderRow, modelAllowed, modelDenied } from "./shared-providers.js";
import { userFromToken } from "./auth.js";
import { broadcast } from "./hub.js";
import { runModelAction } from "./model-admin.js";
import { forgetModels } from "./models.js";
import { inspectProvider, conflictOf } from "./model-load.js";
import { getSettings } from "./projects.js";

function uid(req: { headers: Record<string, any> }): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  return userFromToken(m?.[1])?.userId ?? null;
}

export function registerModelRoutes(app: FastifyInstance): void {
  for (const action of ["load", "unload"] as const) {
    app.post(`/providers/:id/models/${action}`, async (req, reply) => {
      const userId = uid(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const row = getProviderRow((req.params as any).id);
      if (!row || row.user_id !== userId || row.deleted) return reply.code(404).send({ error: "Provider not found" });
      const model = (req.body as any)?.model;
      if (typeof model !== "string" || !model || model.length > 300) return reply.code(400).send({ error: "model is required" });
      if (row.kind !== "openai-compatible") return reply.code(501).send({ error: "unsupported" });
      const given = (req.body as any)?.contextLength;
      if (given != null && (!Number.isInteger(given) || given < 256 || given > 10_000_000)) return reply.code(400).send({ error: "contextLength must be an integer 256..10000000" });
      // Phase 5: a load without contextLength uses the user's defaultContextLength setting (when set).
      const cl = given ?? (action === "load" ? getSettings(userId).defaultContextLength : null);
      const r = await runModelAction(row, action, model, action === "load" && cl ? { contextLength: cl } : undefined);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      forgetModels(row);
      broadcast(userId, { type: "models_changed", providerIds: [row.id] });
      return { ok: true };
    });
  }

  app.get("/providers/:id/models/loaded", async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    // read-only status: a shared provider is visible to its allowed users; load and unload stay with the owner (above)
    const row = getUsableProviderRow(userId, (req.params as any).id);
    if (!row || row.deleted) return reply.code(404).send({ error: "Provider not found" });
    const q = (req.query as any)?.model;
    const model = typeof q === "string" && q && q.length <= 300 ? q : null;
    if (model && row.user_id !== userId && modelDenied(userId, row, model)) return reply.code(403).send({ error: { type: "forbidden", code: "model_not_allowed", message: "This model is not allowed for your account" } });
    if (row.kind !== "openai-compatible") return { controllable: false, loaded: [], targetLoaded: null, conflict: null };
    const insp = await inspectProvider(row, model, true);
    if (row.user_id === userId) {
      return {
        controllable: insp.controllable,
        ...(insp.kind ? { kind: insp.kind } : {}),
        loaded: insp.loaded,
        targetLoaded: insp.targetLoaded,
        conflict: model ? conflictOf(row, model, insp) : null,
      };
    }
    // another user's shared provider: only the models this user may use, and no conflict details (they would name other models)
    const nameOf = (x: any): string => (typeof x === "string" ? x : String(x?.id ?? x?.model ?? x?.name ?? ""));
    const loaded = (insp.loaded as any[]).filter((x) => modelAllowed(userId, row, nameOf(x)));
    return {
      controllable: false,
      ...(insp.kind ? { kind: insp.kind } : {}),
      loaded,
      targetLoaded: model ? insp.targetLoaded : null,
      conflict: null,
    };
  });
}
