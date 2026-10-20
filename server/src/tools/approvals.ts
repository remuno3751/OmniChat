import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { broadcast } from "../hub.js";
import { setCodeStatus } from "../code.js";
import { notify } from "../notify.js";
import { evaluateRules, addBridgeAllowRule } from "../approval-rules.js";

/* Tool approvals (PROTOCOL-v3-phase3.md section 1): grants table + pending WS approvals. */

export type Decision = "once" | "always" | "deny";
export const approvalTimeoutMs = (): number => {
  const n = Number(process.env.TOOL_APPROVAL_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
};

export const hasGrant = (userId: string, tool: string): boolean =>
  !!db.prepare("SELECT 1 FROM tool_grants WHERE user_id = ? AND tool_name = ?").get(userId, tool);

/** New accounts (and, once, existing ones) start with web search pre-approved; revoking the grant later sticks (marker row). */
export function grantDefaults(userId: string): void {
  if (process.env.OMNICHAT_DEFAULT_SEARCH_GRANT === "0") return;
  if (db.prepare("SELECT 1 FROM tool_grants WHERE user_id = ? AND tool_name = '__defaults_v1__'").get(userId)) return;
  addGrant(userId, "web_search");
  addGrant(userId, "__defaults_v1__");
}

export function addGrant(userId: string, tool: string): void {
  db.prepare("INSERT INTO tool_grants (user_id, tool_name, granted_at) VALUES (?,?,?) ON CONFLICT(user_id, tool_name) DO NOTHING").run(userId, tool, Date.now());
}

export const listGrants = (userId: string): { tool: string; grantedAt: number }[] =>
  (db.prepare("SELECT tool_name, granted_at FROM tool_grants WHERE user_id = ? ORDER BY granted_at, tool_name").all(userId) as any[])
    .filter((r) => !String(r.tool_name).startsWith("__")).map((r) => ({ tool: r.tool_name, grantedAt: r.granted_at }));

export function deleteGrant(userId: string, tool: string): boolean {
  // revoking also removes the "always allow" rule that the approval dialog created for this tool
  const rules = Number(db.prepare("DELETE FROM approval_rules WHERE user_id = ? AND project_id IS NULL AND kind = 'tool' AND pattern = ? AND action = 'allow' AND note = 'always allow'").run(userId, tool).changes);
  return Number(db.prepare("DELETE FROM tool_grants WHERE user_id = ? AND tool_name = ?").run(userId, tool).changes) > 0 || rules > 0;
}

/** Why a pending approval was settled: a user answer, or the timeout / abort / no-connection paths. */
type Settle = Decision | "timeout" | "abort";
interface Pending { userId: string; conversationId: string; settle(d: Settle): void }
const pending = new Map<string, Pending>();

const clipChars = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

export interface ApprovalRequest {
  userId: string; messageId: string; conversationId: string; tool: string; arguments: unknown; permissions: string[];
  signal: AbortSignal;
}

/**
 * Registers a pending approval (shared by the chat tool path and the bridge path): marks the conversation
 * awaiting_approval, broadcasts the WS `tool_approval` message and notifies. `finish` runs once, when settled.
 * Settling restores the conversation to "running" when no other approval is waiting and the run was not aborted.
 */
function openPending(
  p: {
    userId: string; conversationId: string; approvalId: string; signal?: AbortSignal;
    tool: string; message: Record<string, unknown>; notifyArgs: unknown;
  },
  finish: (d: Settle) => void,
): void {
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => settle("abort");
  const settle = (d: Settle) => {
    if (!pending.delete(p.approvalId)) return;
    clearTimeout(timer);
    p.signal?.removeEventListener("abort", onAbort);
    if (!p.signal?.aborted && pendingApprovalCount(p.userId, p.conversationId) === 0) {
      setCodeStatus(p.userId, p.conversationId, "running");
    }
    finish(d);
  };
  timer = setTimeout(() => settle("timeout"), approvalTimeoutMs());
  pending.set(p.approvalId, { userId: p.userId, conversationId: p.conversationId, settle });
  p.signal?.addEventListener("abort", onAbort, { once: true });
  setCodeStatus(p.userId, p.conversationId, "awaiting_approval");
  broadcast(p.userId, { ...p.message, codeStatus: "awaiting_approval" });
  let argsText = "";
  try { argsText = JSON.stringify(p.notifyArgs) ?? ""; } catch { argsText = ""; }
  notify(p.userId, "approval", p.conversationId, `Approval needed: ${p.tool}`, clipChars(argsText, 200));
}

/** Asks the user's devices; resolves with the decision. No reply within the timeout, or an aborted generation => "deny". */
export function requestApproval(r: ApprovalRequest): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    if (r.signal.aborted) return resolve("deny");
    const approvalId = randomUUID();
    openPending({
      userId: r.userId, conversationId: r.conversationId, approvalId, signal: r.signal,
      tool: r.tool, notifyArgs: r.arguments,
      message: {
        type: "tool_approval", approvalId, messageId: r.messageId, conversationId: r.conversationId,
        tool: r.tool, arguments: r.arguments, permissions: r.permissions,
      },
    }, (d) => resolve(d === "once" || d === "always" ? d : "deny"));
  });
}

export interface BridgeApprovalRequest {
  userId: string; conversationId: string; messageId: string; projectId: string | null; approvalId: string;
  tool: string; command?: string; path?: string; reason?: string; signal?: AbortSignal;
}
export interface BridgeApprovalResult { decision: "allowed-once" | "rejected"; decidedBy: string }

/**
 * Bridge (dsh) approval: approval rules first (deny and allow answer without a prompt), otherwise the user's devices.
 * "always" also creates a tool allow rule. Timeout / abort => rejected.
 */
export function requestBridgeApproval(r: BridgeApprovalRequest): Promise<BridgeApprovalResult> {
  const rule = evaluateRules(r.userId, r.projectId, { tool: r.tool, command: r.command, path: r.path });
  if (rule.action === "allow") return Promise.resolve({ decision: "allowed-once", decidedBy: `rule:${rule.ruleId}` });
  if (rule.action === "deny") return Promise.resolve({ decision: "rejected", decidedBy: `rule:${rule.ruleId}` });
  return new Promise<BridgeApprovalResult>((resolve) => {
    if (r.signal?.aborted) return resolve({ decision: "rejected", decidedBy: "abort" });
    if (pending.has(r.approvalId)) return resolve({ decision: "rejected", decidedBy: "duplicate" });
    const args = { command: r.command, path: r.path, reason: r.reason };
    openPending({
      userId: r.userId, conversationId: r.conversationId, approvalId: r.approvalId, signal: r.signal,
      tool: r.tool, notifyArgs: args,
      message: {
        type: "tool_approval", approvalId: r.approvalId, messageId: r.messageId, conversationId: r.conversationId,
        tool: r.tool, arguments: args, permissions: [],
      },
    }, (d) => {
      if (d === "once" || d === "always") {
        if (d === "always") addBridgeAllowRule(r.userId, r.projectId, { tool: r.tool, command: r.command, path: r.path });
        return resolve({ decision: "allowed-once", decidedBy: "user" });
      }
      const decidedBy = d === "timeout" ? "timeout" : d === "abort" ? "abort" : "user";
      resolve({ decision: "rejected", decidedBy });
    });
  });
}

/** WS `tool_approval_reply`. False when unknown / not the user's / bad decision. */
export function resolveApproval(userId: string, approvalId: unknown, decision: unknown): boolean {
  if (typeof approvalId !== "string") return false;
  const p = pending.get(approvalId);
  if (!p || p.userId !== userId) return false;
  if (decision !== "once" && decision !== "always" && decision !== "deny") return false;
  p.settle(decision);
  return true;
}

/** The user has no open connection left: nobody can answer. */
export function denyAllFor(userId: string): void {
  for (const p of [...pending.values()]) if (p.userId === userId) p.settle("deny");
}

/** Approvals currently waiting for an answer in one conversation. */
export function pendingApprovalCount(userId: string, conversationId: string): number {
  let n = 0;
  for (const p of pending.values()) if (p.userId === userId && p.conversationId === conversationId) n++;
  return n;
}
