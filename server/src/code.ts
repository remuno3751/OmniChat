import { isAgentBridgeKind, isVscodeBridgeKind } from "./agent-kinds.js";
import { requestVscodeRewind } from "./vscode-bridge.js";
import type { FastifyInstance } from "fastify";
import { db, nextSeq, toConversation, getConversationRow, getProviderRow, type CodeStatus } from "./db.js";
import { broadcast } from "./hub.js";
import { AuthError, authFromRequest } from "./auth.js";
import { listBridges, requestRewind } from "./bridges.js";
import { pendingApprovalCount } from "./tools/approvals.js";

/** Stores the code status of a conversation (bumps seq, broadcasts an upsert). No-op when unchanged. */
export function setCodeStatus(userId: string, conversationId: string, status: CodeStatus): void {
  const row = getConversationRow(conversationId);
  if (!row || row.user_id !== userId || row.code_status === status) return;
  db.prepare("UPDATE conversations SET code_status = ?, seq = ? WHERE id = ?").run(status, nextSeq(), conversationId);
  broadcast(userId, { type: "upsert", conversations: [toConversation(getConversationRow(conversationId))] });
}
const parseChanges = (v: unknown): unknown[] => {
  if (typeof v !== "string" || !v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
};

export function registerCodeRoutes(app: FastifyInstance): void {
  // ---- sessions (Code-mode conversations) ----
  app.get("/code/sessions", async (req) => {
    const userId = authFromRequest(req).userId;
    const rows = db.prepare(
      `SELECT c.id, c.title, c.project_id, c.updated_at, c.code_status, p.kind AS provider_kind, p.base_url AS provider_base_url
         FROM conversations c
         LEFT JOIN providers p ON p.id = c.provider_id AND p.user_id = c.user_id
        WHERE c.user_id = ? AND c.mode = 'code' AND c.deleted = 0
        ORDER BY c.updated_at DESC
        LIMIT 200`,
    ).all(userId) as any[];
    const lastCwd = db.prepare(
      "SELECT cwd FROM checkpoints WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 1",
    );
    let bridgeCwd: Map<string, string> | null = null;
    const sessions = rows.map((r) => {
      const bridge = isAgentBridgeKind(r.provider_kind) && typeof r.provider_base_url === "string" ? r.provider_base_url : "";
      let cwd = "";
      const cp = lastCwd.get(userId, r.id) as { cwd: string } | undefined;
      if (cp && typeof cp.cwd === "string" && cp.cwd) cwd = cp.cwd;
      else if (bridge) {
        if (!bridgeCwd) bridgeCwd = new Map(listBridges(userId).map((b) => [b.name, b.cwd] as [string, string]));
        cwd = bridgeCwd.get(bridge) ?? "";
      }
      return {
        conversationId: r.id,
        title: r.title,
        projectId: r.project_id ?? null,
        cwd,
        bridge,
        codeStatus: r.code_status,
        updatedAt: r.updated_at,
        pendingApprovals: pendingApprovalCount(userId, r.id),
      };
    });
    return { sessions };
  });

  // ---- full stored changes of one message ----
  app.get("/messages/:id/changes", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const row = db.prepare("SELECT id, user_id, changes FROM messages WHERE id = ?").get(id) as any;
    if (!row || row.user_id !== userId) throw new AuthError("Message not found", 404);
    return { messageId: row.id, changes: parseChanges(row.changes) };
  });

  // ---- checkpoints of a conversation ----
  app.get("/code/checkpoints", async (req) => {
    const userId = authFromRequest(req).userId;
    const conversationId = (req.query as any)?.conversationId;
    if (typeof conversationId !== "string" || !conversationId) throw new AuthError("conversationId is required", 400);
    const conv = getConversationRow(conversationId);
    if (!conv || conv.user_id !== userId) throw new AuthError("Conversation not found", 404);
    const rows = db.prepare(
      "SELECT * FROM checkpoints WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC",
    ).all(userId, conversationId) as any[];
    return {
      checkpoints: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        messageId: r.message_id ?? null,
        bridge: r.bridge,
        cwd: r.cwd ?? "",
        ref: r.ref ?? null,
        unavailable: r.unavailable ?? null,
        dirty: !!r.dirty,
        createdAt: r.created_at,
      })),
    };
  });

  // ---- rewind to a checkpoint (client confirms first) ----
  app.post("/code/checkpoints/:id/rewind", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const removeNew = !!((req.body ?? {}) as any).removeNew;
    const cp = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as any;
    if (!cp || cp.user_id !== userId) throw new AuthError("Checkpoint not found", 404);
    if (!cp.ref) return reply.code(400).send({ error: cp.unavailable ? `Checkpoint unavailable: ${cp.unavailable}` : "Checkpoint has no snapshot" });
    const conv = getConversationRow(cp.conversation_id);
    if (conv && (conv.code_status === "running" || (conv.code_status === "awaiting_approval" && isVscodeBridgeKind(getProviderRow(conv.provider_id)?.kind)))) {
      return reply.code(409).send({ error: "Conversation is running" });
    }
    if (conv?.provider_id && isVscodeBridgeKind(getProviderRow(conv.provider_id)?.kind)) {
      // VS Code bridge: the instance that has the folder open restores the checkpoint (refused while a run is active; open dirty editors are reported)
      const vr = await requestVscodeRewind(userId, cp.bridge, cp.ref, cp.cwd ?? "", removeNew);
      if (vr.ok) return { ok: true };
      if (vr.error === "dirty_editors") return reply.code(409).send({ error: "dirty_editors", code: "dirty_editors" });
      return reply.code(502).send({ error: vr.error ?? "rewind failed" });
    }
    const result = await requestRewind(userId, cp.bridge, cp.ref, cp.cwd ?? "", removeNew);
    if (!result.ok) return reply.code(502).send({ error: result.error ?? "rewind failed" });
    return { ok: true };
  });
}
