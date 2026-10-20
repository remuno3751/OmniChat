import type { FastifyInstance } from "fastify";
import { getUsableProviderRow } from "./shared-providers.js";
import { AuthError, authFromRequest } from "./auth.js";
import { tokenizeText } from "./tokenize.js";
import { apiKeyOf } from "./model-admin.js";
import { listComparisons, getComparison, deleteComparison } from "./compare.js";
import { listSets, upsertSet, deleteSet, startRun, listRuns, getRun, deleteRun, cancelRun, runCsv } from "./bench.js";
import { serializeExport, parseConfig, importConfig, CONFIG_LIMIT } from "./configfile.js";

/* Developer features (PROTOCOL-v3-phase4.md sections 2-5): token view, comparisons, benchmark runner, config files. */

const isStr = (v: unknown): v is string => typeof v === "string";

/** Phase 4 (developer features): token view, comparison storage, benchmark runner, config export/import. */
export function registerDevRoutes(app: FastifyInstance): void {
  // ---- token view ----
  app.post("/tokenize", async (req) => {
    const userId = authFromRequest(req).userId;
    const b = (req.body ?? {}) as any;
    if (!isStr(b.text)) throw new AuthError("text must be a string", 400);
    let baseUrl: string | null = null;
    let apiKey: string | undefined;
    if (b.providerId != null) {
      if (!isStr(b.providerId)) throw new AuthError("providerId must be a string", 400);
      const prov = getUsableProviderRow(userId, b.providerId);
      if (!prov || prov.deleted) throw new AuthError("Provider not found", 404);
      if (prov.kind === "openai-compatible") { baseUrl = prov.base_url; apiKey = apiKeyOf(prov); }
    }
    return tokenizeText(b.text, baseUrl, undefined, apiKey);
  });

  // ---- comparisons (stored separately from chats; created over WS) ----
  app.get("/comparisons", async (req) => {
    const userId = authFromRequest(req).userId;
    return { comparisons: listComparisons(userId) };
  });
  app.get("/comparisons/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const c = getComparison(userId, (req.params as any).id);
    if (!c) throw new AuthError("Comparison not found", 404);
    return c;
  });
  app.delete("/comparisons/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    if (!deleteComparison(userId, (req.params as any).id)) throw new AuthError("Comparison not found", 404);
    return { ok: true };
  });

  // ---- benchmark prompt sets ----
  app.get("/bench/sets", async (req) => {
    const userId = authFromRequest(req).userId;
    return { sets: listSets(userId) };
  });
  app.put("/bench/sets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    return upsertSet(userId, (req.params as any).id, req.body ?? {});
  });
  app.delete("/bench/sets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    if (!deleteSet(userId, (req.params as any).id)) throw new AuthError("Set not found", 404);
    return { ok: true };
  });

  // ---- benchmark runs ----
  app.post("/bench/runs", async (req) => {
    const userId = authFromRequest(req).userId;
    return startRun(userId, req.body ?? {});
  });
  app.get("/bench/runs", async (req) => {
    const userId = authFromRequest(req).userId;
    return { runs: listRuns(userId) };
  });
  app.get("/bench/runs/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const r = getRun(userId, (req.params as any).id);
    if (!r) throw new AuthError("Run not found", 404);
    return r;
  });
  app.get("/bench/runs/:id/export", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const csv = runCsv(userId, (req.params as any).id);
    if (csv === null) throw new AuthError("Run not found", 404);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="bench-${(req.params as any).id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 60)}.csv"`);
    return csv;
  });
  app.post("/bench/runs/:id/cancel", async (req) => {
    const userId = authFromRequest(req).userId;
    const r = cancelRun(userId, (req.params as any).id);
    if (r === "notfound") throw new AuthError("Run not found", 404);
    if (r === "notrunning") throw new AuthError("Run is not running", 409);
    return { ok: true };
  });
  app.delete("/bench/runs/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const r = deleteRun(userId, (req.params as any).id);
    if (r === "notfound") throw new AuthError("Run not found", 404);
    if (r === "running") throw new AuthError("Run is still running", 409);
    return { ok: true };
  });

  // ---- config as files ----
  app.get("/config/export", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const f = String((req.query as any)?.format ?? "json");
    if (f !== "json" && f !== "yaml") throw new AuthError("format must be json or yaml", 400);
    const out = serializeExport(userId, f);
    reply.header("content-type", out.type);
    reply.header("content-disposition", `attachment; filename="${out.filename}"`);
    return out.body;
  });
  app.post("/config/import", { bodyLimit: CONFIG_LIMIT * 2 + 1024 }, async (req) => {
    const h = String(req.headers.authorization ?? "");
    const userId = authFromRequest(req).userId;
    const b = (req.body ?? {}) as any;
    const mode = b.mode === undefined ? "merge" : b.mode;
    if (mode !== "merge" && mode !== "replace") throw new AuthError("mode must be merge or replace", 400);
    const doc = parseConfig(b.format, b.content);
    return importConfig(app, h, userId, doc, mode);
  });
}
