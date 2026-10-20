import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { getProjectRow } from "./projects.js";

export type RuleAction = "allow" | "deny" | "ask";
export interface RuleQuery { tool?: string; command?: string; path?: string }
export interface RuleDecision { action: RuleAction; ruleId: string | null }

interface RuleRow { id: string; user_id: string; project_id: string | null; kind: string; pattern: string; action: RuleAction; created_at: number; note: string | null }

const KINDS: string[] = ["tool", "command", "path"];
const ACTIONS: string[] = ["allow", "deny", "ask"];
const RANK: Record<RuleAction, number> = { deny: 0, allow: 1, ask: 2 };
const MAX_RULES = 500;
const isStr = (v: unknown): v is string => typeof v === "string";
const bad = (msg: string) => new AuthError(msg, 400);

/** `*` = any chars, `?` = one char, everything else literal; anchored, case-sensitive. */
export function globMatch(glob: string, s: string): boolean {
  // iterative wildcard matching with single-star backtracking: O(glob * s), no regex (no catastrophic backtracking)
  const g = [...glob], t = [...s];
  let gi = 0, ti = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (gi < g.length && g[gi] !== "*" && (g[gi] === "?" || g[gi] === t[ti])) { gi++; ti++; }
    else if (gi < g.length && g[gi] === "*") { star = gi++; mark = ti; }
    else if (star >= 0) { gi = star + 1; ti = ++mark; }
    else return false;
  }
  while (gi < g.length && g[gi] === "*") gi++;
  return gi === g.length;
}

/** Shell control characters: a broad command allow-rule like "git *" must not approve "git status; curl x | sh". */
const SHELL_META = /[;&|`<>\n\r]|\$\(/;

const toRule = (r: any) => ({
  id: r.id, projectId: r.project_id ?? null, kind: r.kind, pattern: r.pattern, action: r.action,
  createdAt: r.created_at, note: r.note ?? null,
});

/** Most specific wins (project over global; deny > allow > ask); no match => ask. */
export function evaluateRules(userId: string, projectId: string | null, q: RuleQuery): RuleDecision {
  const rows = db.prepare(
    "SELECT id, project_id, kind, pattern, action FROM approval_rules WHERE user_id = ? AND (project_id IS NULL OR project_id = ?) ORDER BY created_at, id",
  ).all(userId, projectId) as unknown as RuleRow[];
  const hits = rows.filter((r) => {
    const s = r.kind === "tool" ? q.tool : r.kind === "command" ? q.command : r.kind === "path" ? q.path : undefined;
    if (s === undefined) return false;
    if (r.kind === "tool") return r.pattern === s;
    if (r.kind === "command" && r.action === "allow" && SHELL_META.test(s)) return false;
    return globMatch(r.pattern, s);
  });
  const proj = hits.filter((r) => r.project_id !== null);
  const pool = proj.length ? proj : hits;
  let best: RuleRow | undefined;
  for (const r of pool) if (!best || RANK[r.action] < RANK[best.action]) best = r;
  return best ? { action: best.action, ruleId: best.id } : { action: "ask", ruleId: null };
}

/** "Always allow" in the approval dialog: an allow rule of kind 'tool' (reuses an identical one). */
/**
 * "Always allow" for a bridge (dsh) request. Bridge tools run arbitrary shell commands and file operations, so a rule
 * on the tool name alone would approve everything from then on: remember the exact command (or path) instead.
 * Patterns that contain glob characters are not remembered (the user is simply asked again).
 */
export function addBridgeAllowRule(userId: string, projectId: string | null, q: { tool: string; command?: string; path?: string }): string | null {
  const kind = q.command ? "command" : q.path ? "path" : null;
  if (!kind) return addToolAllowRule(userId, projectId, q.tool);
  const pattern = (q.command ?? q.path) as string;
  if (/[*?]/.test(pattern) || pattern.length > 1000) return null;
  const existing = db.prepare(
    "SELECT id FROM approval_rules WHERE user_id = ? AND project_id IS ? AND kind = ? AND pattern = ? AND action = 'allow' LIMIT 1",
  ).get(userId, projectId, kind, pattern) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO approval_rules (id, user_id, project_id, kind, pattern, action, created_at, note) VALUES (?,?,?,?,?,'allow',?,'always allow (exact)')",
  ).run(id, userId, projectId, kind, pattern, Date.now());
  return id;
}

export function addToolAllowRule(userId: string, projectId: string | null, tool: string): string {
  const existing = db.prepare(
    "SELECT id FROM approval_rules WHERE user_id = ? AND project_id IS ? AND kind = 'tool' AND pattern = ? AND action = 'allow' LIMIT 1",
  ).get(userId, projectId, tool) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO approval_rules (id, user_id, project_id, kind, pattern, action, created_at, note) VALUES (?,?,?,?,?,'allow',?,'always allow')",
  ).run(id, userId, projectId, "tool", tool, Date.now());
  return id;
}

export function registerApprovalRuleRoutes(app: FastifyInstance): void {
  app.get("/approval-rules", async (req) => {
    const userId = authFromRequest(req).userId;
    const pid = ((req.query ?? {}) as any).projectId;
    let rows: RuleRow[];
    if (pid === undefined) {
      rows = db.prepare("SELECT * FROM approval_rules WHERE user_id = ? ORDER BY created_at, id").all(userId) as unknown as RuleRow[];
    } else if (pid === "global") {
      rows = db.prepare("SELECT * FROM approval_rules WHERE user_id = ? AND project_id IS NULL ORDER BY created_at, id").all(userId) as unknown as RuleRow[];
    } else if (isStr(pid)) {
      rows = db.prepare("SELECT * FROM approval_rules WHERE user_id = ? AND (project_id IS NULL OR project_id = ?) ORDER BY created_at, id").all(userId, pid) as unknown as RuleRow[];
    } else throw bad("projectId must be a string");
    return { rules: rows.map(toRule) };
  });

  app.put("/approval-rules/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    if (!KINDS.includes(b.kind)) throw bad("kind must be tool, command or path");
    if (!ACTIONS.includes(b.action)) throw bad("action must be allow, deny or ask");
    if (!isStr(b.pattern) || !b.pattern || b.pattern.length > 300) throw bad("pattern must be a non-empty string of at most 300 characters");
    if (b.note != null && (!isStr(b.note) || b.note.length > 300)) throw bad("note must be a string of at most 300 characters");
    const note: string | null = b.note ?? null;
    let projectId: string | null = null;
    if (b.projectId === undefined) {
      const cur = db.prepare("SELECT project_id FROM approval_rules WHERE id = ? AND user_id = ?").get(id, userId) as { project_id: string | null } | undefined;
      projectId = cur?.project_id ?? null;
    } else if (b.projectId != null) {
      if (!isStr(b.projectId)) throw bad("projectId must be a string or null");
      const p = getProjectRow(b.projectId);
      if (!p || p.user_id !== userId || p.deleted) throw bad("Unknown project");
      projectId = b.projectId;
    }

    const row = db.prepare("SELECT user_id FROM approval_rules WHERE id = ?").get(id) as { user_id: string } | undefined;
    if (row && row.user_id !== userId) throw new AuthError("Forbidden", 403);
    if (!row) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM approval_rules WHERE user_id = ?").get(userId) as { n: number }).n;
      if (n >= MAX_RULES) throw bad(`too many rules (max ${MAX_RULES})`);
    }
    db.prepare(
      "INSERT INTO approval_rules (id, user_id, project_id, kind, pattern, action, created_at, note) VALUES (?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, pattern = excluded.pattern, action = excluded.action, note = excluded.note",
    ).run(id, userId, projectId, b.kind, b.pattern, b.action, Date.now(), note);
    return toRule(db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id));
  });

  app.delete("/approval-rules/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const r = db.prepare("DELETE FROM approval_rules WHERE id = ? AND user_id = ?").run(id, userId);
    if (!r.changes) throw new AuthError("Rule not found", 404);
    return { ok: true };
  });
}
