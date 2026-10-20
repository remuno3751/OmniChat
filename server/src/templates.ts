import type { FastifyInstance } from "fastify";
import { db, nextSeq } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { broadcast } from "./hub.js";
import { getProjectRow } from "./projects.js";

export interface Template {
  id: string; projectId: string | null; name: string; body: string; description: string; kind: "prompt" | "action";
  createdAt: number; updatedAt: number; deleted: boolean; seq: number;
}
export const toTemplate = (r: any): Template => ({
  id: r.id, projectId: r.project_id ?? null, name: r.name, body: r.body ?? "", description: r.description ?? "",
  kind: r.kind === "action" ? "action" : "prompt", createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq,
});

const isStr = (v: unknown): v is string => typeof v === "string";
const bad = (msg: string) => new AuthError(msg, 400);
const has = (b: any, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const MAX_BODY = 20_000;
const MAX_DESC = 500;
const ACTION_BODIES = new Set([
  "new_session", "approval_mode:ask", "approval_mode:rules",
  "search:off", "search:smart", "search:auto", "search:always",
]);

const getTemplateRow = (id: string): any => db.prepare("SELECT * FROM templates WHERE id = ?").get(id);

function nameOf(v: unknown): string {
  if (!isStr(v)) throw bad("name must be a string");
  const t = v.trim();
  if (t.length < 1 || t.length > 60) throw bad("name must be 1..60 characters");
  return t;
}
function bodyOf(v: unknown): string {
  if (!isStr(v) || v.length > MAX_BODY) throw bad(`body must be a string of at most ${MAX_BODY} characters`);
  return v;
}
function descOf(v: unknown): string {
  if (v === null) return "";
  if (!isStr(v) || v.length > MAX_DESC) throw bad(`description must be a string of at most ${MAX_DESC} characters`);
  return v;
}
function kindOf(v: unknown): "prompt" | "action" {
  if (v === "prompt" || v === "action") return v;
  throw bad("kind must be 'prompt' or 'action'");
}

/** Templates for the user with seq > since (including soft-deleted rows), in seq order. */
export function listTemplatesSince(userId: string, since: number): Template[] {
  const rows = db.prepare("SELECT * FROM templates WHERE user_id = ? AND seq > ? ORDER BY seq").all(userId, since);
  return rows.map((r) => toTemplate(r));
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  // ---- list ----
  // no projectId = all; projectId=global = only globals (project_id NULL); projectId=<id> = that project's plus globals.
  app.get("/templates", async (req) => {
    const userId = authFromRequest(req).userId;
    const q = (req.query ?? {}) as any;
    let rows: any[];
    if (q.projectId === undefined) {
      rows = db.prepare("SELECT * FROM templates WHERE user_id = ? AND deleted = 0 ORDER BY name").all(userId);
    } else if (!isStr(q.projectId)) {
      throw bad("projectId must be a string");
    } else if (q.projectId === "global") {
      rows = db.prepare("SELECT * FROM templates WHERE user_id = ? AND deleted = 0 AND project_id IS NULL ORDER BY name").all(userId);
    } else {
      rows = db.prepare("SELECT * FROM templates WHERE user_id = ? AND deleted = 0 AND (project_id = ? OR project_id IS NULL) ORDER BY name")
        .all(userId, q.projectId);
    }
    return { templates: rows.map((r) => toTemplate(r)) };
  });

  // ---- create / update ----
  app.put("/templates/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    const row = getTemplateRow(id);
    if (row && row.user_id !== userId) throw new AuthError("Forbidden", 403);

    // Validate before writing anything.
    const name = has(b, "name") ? nameOf(b.name) : row ? row.name : undefined;
    if (name === undefined) throw bad("name is required");
    const body = has(b, "body") ? bodyOf(b.body) : row ? row.body ?? "" : undefined;
    if (body === undefined) throw bad("body is required");
    const description = has(b, "description") ? descOf(b.description) : row ? row.description ?? "" : "";
    const kind: "prompt" | "action" = has(b, "kind") ? kindOf(b.kind) : row && row.kind === "action" ? "action" : "prompt";
    if (kind === "action" && !ACTION_BODIES.has(body)) {
      throw bad("action body must be one of new_session, approval_mode:ask, approval_mode:rules, search:off, search:smart, search:auto, search:always");
    }
    let projectId: string | null = row ? row.project_id ?? null : null;
    if (has(b, "projectId")) {
      if (b.projectId === null) projectId = null;
      else if (isStr(b.projectId)) {
        const p = getProjectRow(b.projectId);
        if (!p || p.user_id !== userId || p.deleted) throw bad("Unknown project");
        projectId = b.projectId;
      } else throw bad("projectId must be a string or null");
    }
    const dup = db.prepare("SELECT id FROM templates WHERE user_id = ? AND name = ? AND project_id IS ? AND deleted = 0 AND id <> ?")
      .get(userId, name, projectId, id);
    if (dup) throw bad("Template name already exists");

    const now = Date.now();
    const seq = nextSeq();
    if (!row) {
      db.prepare("INSERT INTO templates (id, user_id, project_id, name, body, description, kind, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,?,0,?)")
        .run(id, userId, projectId, name, body, description, kind, now, now, seq);
    } else {
      db.prepare("UPDATE templates SET project_id = ?, name = ?, body = ?, description = ?, kind = ?, updated_at = ?, deleted = 0, seq = ? WHERE id = ?")
        .run(projectId, name, body, description, kind, now, seq, id);
    }
    const tpl = toTemplate(getTemplateRow(id));
    broadcast(userId, { type: "upsert", templates: [tpl] });
    return tpl;
  });

  // ---- soft delete ----
  app.delete("/templates/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const row = getTemplateRow(id);
    if (!row || row.user_id !== userId) throw new AuthError("Template not found", 404);
    db.prepare("UPDATE templates SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), id);
    const tpl = toTemplate(getTemplateRow(id));
    broadcast(userId, { type: "upsert", templates: [tpl] });
    return tpl;
  });
}
