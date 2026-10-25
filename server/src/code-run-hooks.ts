/* Per-run glue between the VS Code agent loop and the rest of the server (docs/design/VSCODE-BRIDGE.md S8, S9):
   approval decisions (policy -> user), extension-originated approvals, approval_pending / approval_settled / approval_decision,
   and persistence of checkpoint / changes frames with the existing v4 storage. */
import { randomUUID } from "node:crypto";
import { db, getConversationRow, getMessageRow, setMessageV4, toMessage } from "./db.js";
import { broadcast } from "./hub.js";
import { sanitizeChanges } from "./bridges.js";
import { decideToolCall, requestBridgeApproval, resolveApproval } from "./tools/approvals.js";
import type { ApprovalMode } from "./vscode-policy.js";
import type { RawFrame, ToolApproval, VscodeRun, VscodeRunHooks } from "./vscode-bridge.js";
import { callSummary } from "./code-tools.js";

export interface RunSupportCtx {
  userId: string; conversationId: string; assistantMessageId: string; bridge: string; cwd: string; roots: string[]; signal: AbortSignal;
}

export type AuthResult =
  | { ok: true; approval: ToolApproval; decidedBy: string }
  | { ok: false; decidedBy: string; message: string };

const clipStr = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");

export function currentApprovalMode(conversationId: string): ApprovalMode {
  const m = getConversationRow(conversationId)?.approval_mode;
  return m === "auto" || m === "full" ? m : "manual";
}

export class RunSupport {
  /** set once the run is open */
  run: VscodeRun | null = null;
  /** the call being executed right now (calls run one at a time): lets extension-originated approvals find their arguments */
  current: { tool: string; args: Record<string, unknown> } | null = null;
  /** live tool_progress sink of the current call */
  onProgress: ((stream: "stdout" | "stderr", text: string) => void) | null = null;
  private readonly serverApprovals = new Set<string>();

  constructor(private readonly c: RunSupportCtx) {}

  private projectId(): string | null {
    return getConversationRow(this.c.conversationId)?.project_id ?? null;
  }

  /** Policy decision for one call: deny rule > protected > allow rule > mode > ask (the user is asked on "ask"). */
  async authorize(tool: string, args: Record<string, unknown>): Promise<AuthResult> {
    const d = decideToolCall({ userId: this.c.userId, projectId: this.projectId(), tool, args, roots: this.c.roots, mode: currentApprovalMode(this.c.conversationId) });
    if (d.action === "deny") return { ok: false, decidedBy: d.by, message: `denied by rule${d.reasons.length > 1 ? ` (${d.reasons.slice(1).join("; ")})` : ""}` };
    if (d.action === "allow") return { ok: true, approval: { by: d.by, protectedOk: false, ...(d.outsideOk ? { outsideOk: true } : {}) }, decidedBy: d.by };
    const approvalId = randomUUID();
    const r = await this.ask(approvalId, tool, args, d.protected, d.reasons, false);
    if (r.decision === "allowed-once") return { ok: true, approval: { by: "user", protectedOk: d.protected, ...(d.outsideOk ? { outsideOk: true } : {}) }, decidedBy: r.decidedBy };
    const why = r.decidedBy === "timeout" ? "approval timed out" : r.decidedBy === "abort" ? "cancelled" : "denied by user";
    return { ok: false, decidedBy: r.decidedBy, message: why };
  }

  private async ask(approvalId: string, tool: string, args: Record<string, unknown>, isProtected: boolean, reasons: string[], fromExtension: boolean) {
    const run = this.run;
    if (!fromExtension) {
      this.serverApprovals.add(approvalId);
      if (run?.approvalCapable) run.sendFrame({ type: "approval_pending", approvalId, tool, summary: callSummary(tool, args), protected: isProtected, reasons });
    }
    try {
      const r = await requestBridgeApproval({
        userId: this.c.userId, conversationId: this.c.conversationId, messageId: this.c.assistantMessageId, projectId: this.projectId(), approvalId, tool,
        command: typeof args.command === "string" ? args.command.slice(0, 4000) : undefined,
        path: typeof args.path === "string" ? args.path.slice(0, 1000) : undefined,
        reason: reasons.join("; ").slice(0, 1000) || undefined,
        signal: this.c.signal, skipRules: true, protected: isProtected, reasons,
      });
      if (!fromExtension && run?.approvalCapable) {
        run.sendFrame({ type: "approval_settled", approvalId, decision: r.decision === "allowed-once" ? "once" : "deny", decidedBy: r.decidedBy });
      }
      return r;
    } finally {
      this.serverApprovals.delete(approvalId);
    }
  }

  /** Hooks passed to openRun. */
  readonly hooks: VscodeRunHooks = {
    onCheckpoint: (f) => this.storeCheckpoint(f),
    onChanges: (f) => this.storeChanges(f),
    onProgress: (_callId, stream, text) => this.onProgress?.(stream, text),
    onApprovalDecision: (f) => {
      const id = clipStr(f.approvalId, 200);
      if (!id || !this.serverApprovals.has(id)) return; // never resolves an extension-originated approval
      resolveApproval(this.c.userId, id, f.decision === "once" ? "once" : "deny");
    },
    onApproval: async (f) => {
      // The extension's own checks (symlink / realpath, secrets) found something the server's lexical policy did not: always ask the user.
      const tool = clipStr(f.tool, 200) || "tool";
      const cur = this.current && this.current.tool === tool ? this.current.args : {};
      const args: Record<string, unknown> = { ...cur, ...(typeof f.path === "string" && f.path ? { path: f.path.slice(0, 1000) } : {}) };
      const d = decideToolCall({ userId: this.c.userId, projectId: this.projectId(), tool, args, roots: this.c.roots, mode: currentApprovalMode(this.c.conversationId) });
      if (d.action === "deny") return "rejected";
      const reason = clipStr(f.reason, 500) || "flagged by the VS Code extension";
      const r = await this.ask(clipStr(f.approvalId, 200) || randomUUID(), tool, args, true, [`extension: ${reason}`, ...(d.protected ? d.reasons : [])], true);
      return r.decision;
    },
  };

  /** `checkpoint` frame: same storage as the dsh bridge (checkpoints table); cwd is the run's folder. */
  private storeCheckpoint(m: RawFrame): void {
    const c = this.c;
    const checkpointId = clipStr(m.checkpointId, 200);
    if (!checkpointId) return;
    const createdAt = typeof m.createdAt === "number" && Number.isFinite(m.createdAt) ? m.createdAt : Date.now();
    const dirty = m.dirty === true ? 1 : 0;
    const unavailable = typeof m.unavailable === "string" ? clipStr(m.unavailable, 500) || "unavailable" : null;
    const ref = unavailable || typeof m.ref !== "string" || !m.ref ? null : clipStr(m.ref, 200);
    db.prepare(
      "INSERT OR REPLACE INTO checkpoints (id, user_id, conversation_id, message_id, bridge, cwd, ref, unavailable, dirty, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(checkpointId, c.userId, c.conversationId, c.assistantMessageId, c.bridge, c.cwd, ref, unavailable, dirty, createdAt);
    if (unavailable) broadcast(c.userId, { type: "checkpoint_unavailable", conversationId: c.conversationId, messageId: c.assistantMessageId, reason: unavailable });
    else broadcast(c.userId, { type: "checkpoint", conversationId: c.conversationId, messageId: c.assistantMessageId, checkpointId, createdAt, dirty: dirty === 1 });
  }

  /** `changes` frame: sanitized (sizes capped) and stored on the assistant message. */
  private storeChanges(m: RawFrame): void {
    const c = this.c;
    setMessageV4(c.assistantMessageId, { changes: sanitizeChanges(m.changes) });
    const row = getMessageRow(c.assistantMessageId);
    if (row) broadcast(c.userId, { type: "upsert", messages: [toMessage(row)] });
  }
}
