import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { searchHistory } from "./history-search.js";
import { actorOf, recordAudit } from "./admin-core.js";
import { createBackup, listBackups, deleteBackup, backupPath, startBackupScheduler } from "./backup.js";
import {
  conversationJson, conversationMarkdown, fullExport, importData, contentDisposition, getOwnedConversation, IMPORT_LIMIT,
} from "./export.js";

const flag = (v: unknown) => v === "1" || v === "true";

function requireAdmin(req: { headers: Record<string, any> }): string {
  const userId = authFromRequest(req).userId;
  const u = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
  if (!u?.is_admin) throw new AuthError("Admin only", 403);
  return userId;
}
const ymd = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** Phase 3 (server B): history search, backups, export/import. Also starts the backup scheduler. */
export function registerHistoryRoutes(app: FastifyInstance): void {
  app.get("/history/search", async (req) => {
    const userId = authFromRequest(req).userId;
    const q = req.query as any;
    return searchHistory(userId, typeof q.q === "string" ? q.q : "", {
      projectId: typeof q.projectId === "string" && q.projectId ? q.projectId : null,
      limit: Number.parseInt(String(q.limit ?? "20"), 10),
      offset: Number.parseInt(String(q.offset ?? "0"), 10),
    });
  });

  // ---- backups (admin) ----
  app.post("/admin/backup", async (req) => {
    const userId = requireAdmin(req);
    const info = createBackup();
    recordAudit(actorOf(userId), "backup.create", info.name);
    return info;
  });
  app.get("/admin/backups", async (req) => { requireAdmin(req); return { backups: listBackups() }; });
  app.get("/admin/backups/:name", async (req, reply) => {
    requireAdmin(req);
    const name = (req.params as any).name;
    const p = backupPath(name);
    if (!p || !listBackups().some((b) => b.name === name)) throw new AuthError("Backup not found", 404);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${name}"`)
      .send(createReadStream(p));
  });
  app.delete("/admin/backups/:name", async (req) => {
    const userId = requireAdmin(req);
    const name = (req.params as any).name as string;
    if (!deleteBackup(name)) throw new AuthError("Backup not found", 404);
    recordAudit(actorOf(userId), "backup.delete", name);
    return { ok: true };
  });

  // ---- export / import ----
  app.get("/conversations/:id/export", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const q = req.query as any;
    const format = q.format === undefined || q.format === "md" ? "md" : q.format === "json" ? "json" : null;
    const branches = q.branches === undefined || q.branches === "current" ? "current" : q.branches === "all" ? "all" : null;
    if (!format) throw new AuthError("format must be md or json", 400);
    if (!branches) throw new AuthError("branches must be current or all", 400);
    const reasoning = flag(q.reasoning);
    const title = getOwnedConversation(userId, id).title as string;
    if (format === "json") {
      return reply.header("content-type", "application/json; charset=utf-8")
        .header("content-disposition", contentDisposition(title, "json"))
        .send(JSON.stringify(conversationJson(userId, id, branches, reasoning), null, 2));
    }
    return reply.header("content-type", "text/markdown; charset=utf-8")
      .header("content-disposition", contentDisposition(title, "md"))
      .send(conversationMarkdown(userId, id, branches, reasoning));
  });

  app.get("/export", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    return reply.header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", contentDisposition(`omnichat-export-${ymd()}`, "json"))
      .send(JSON.stringify(fullExport(userId), null, 2));
  });

  app.post("/import", { bodyLimit: IMPORT_LIMIT }, async (req) => {
    const userId = authFromRequest(req).userId;
    return importData(userId, req.body);
  });

  startBackupScheduler();
}
