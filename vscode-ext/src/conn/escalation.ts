/**
 * Approval gate for tool calls (spec docs/design/VSCODE-BRIDGE.md §2.2–2.4, §4.2).
 *
 * `gate(call, signal)` runs before a call executes. It allows the call when the server already
 * approved a protected item (`protectedOk`) or when the extension's own check finds nothing protected.
 * Otherwise it sends an `approval` frame and waits for the server's matching `approval_reply`
 * (the server is the final authority, spec §2.4). There is no "always allow" path.
 *
 * Timeouts: the approval wait is not part of the call's timeout. The gate reports the wait through
 * `onWaiting(callId, true|false)` and the run manager pauses that call's timer while it is true.
 * The approval wait has its own limit (TOOL_APPROVAL_TIMEOUT_MS). Expiry is a denial.
 *
 * Cancel, abort, disconnect (`cancelAll`) and a failed send all end a wait as `cancelled`.
 */
import { randomUUID } from "node:crypto";
import { checkProtected as defaultCheckProtected, type ProtectedContext, type ProtectedCall, type ProtectedVerdict } from "../guard/protected";
import type { RealpathFn } from "../guard/paths";
import { validateArgs } from "../tools/schemas";
import type {
  ApprovalFrame,
  ApprovalReplyFrame,
  Frame,
  ToolCallFrame,
} from "../protocol/frames";

/** Spec §4.4: the approval wait limit. Expiry denies the call. */
export const TOOL_APPROVAL_TIMEOUT_MS = 120_000;

export type GateErrorCode = "denied" | "cancelled";

export type GateResult =
  | { allow: true }
  | { allow: false; error: { code: GateErrorCode; message: string } };

/** An `approval` frame as the extension sends it, plus the protection rule (for the UI). */
export type ApprovalOpen = ApprovalFrame & { rule: string; command?: string };

export interface EscalationTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EscalationOptions {
  /** Sends a frame to the server. False when the connection is down. */
  send: (frame: Frame) => boolean;
  checkProtected?: (call: ProtectedCall, ctx: ProtectedContext) => Promise<ProtectedVerdict>;
  /** Run roots (absolute). Read when a gate is evaluated. */
  getRoots: () => readonly string[];
  /** Run cwd (absolute). Read when a gate is evaluated. */
  getCwd: () => string;
  /** Symlink resolver from the host. Omit to check lexically only. */
  realpath?: RealpathFn;
  newId?: () => string;
  timers?: EscalationTimers;
  /** Approval wait limit. Defaults to TOOL_APPROVAL_TIMEOUT_MS. */
  approvalTimeoutMs?: number;
  /** The number of pending approvals changed. */
  onPendingChange?: (count: number) => void;
  /** A call started or stopped waiting for an approval. The run pauses that call's timeout. */
  onWaiting?: (callId: string, waiting: boolean) => void;
}

export interface Escalation {
  gate(call: ToolCallFrame, signal: AbortSignal): Promise<GateResult>;
  /**
   * Server's `approval_reply` for an extension-originated approval. Returns true when one was pending.
   * Any decision other than `allowed-once` is a rejection. Nothing else resolves a gate.
   */
  handleReply(frame: ApprovalReplyFrame): boolean;
  /** Ends every pending approval as cancelled (cancel, disconnect, dispose). */
  cancelAll(): void;
  pendingCount(): number;
}

interface Pending {
  callId: string;
  resolve: (result: GateResult) => void;
  timer: unknown;
  onAbort: () => void;
  signal: AbortSignal;
}

const ALLOW: GateResult = { allow: true };
const deny = (message: string): GateResult => ({ allow: false, error: { code: "denied", message } });
const cancelled = (message: string): GateResult => ({ allow: false, error: { code: "cancelled", message } });

const defaultTimers: EscalationTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Path shown in the approval card: the call's path, then its cwd, then the run cwd. */
function pathOf(args: Record<string, unknown>, cwd: string): string {
  if (typeof args.path === "string") return args.path;
  if (typeof args.cwd === "string") return args.cwd;
  return cwd;
}

export function createEscalation(opts: EscalationOptions): Escalation {
  const timers = opts.timers ?? defaultTimers;
  const checkProtected = opts.checkProtected ?? defaultCheckProtected;
  const newId = opts.newId ?? randomUUID;
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;
  const pending = new Map<string, Pending>();

  /** Settles one wait. False if it was already settled. */
  const settle = (approvalId: string, result: GateResult): boolean => {
    const p = pending.get(approvalId);
    if (!p) return false;
    pending.delete(approvalId);
    timers.clearTimeout(p.timer);
    p.signal.removeEventListener("abort", p.onAbort);
    opts.onWaiting?.(p.callId, false);
    opts.onPendingChange?.(pending.size);
    p.resolve(result);
    return true;
  };

  /** Protection verdict for a call. A check that throws counts as protected (fail closed). */
  const verdictOf = async (call: ToolCallFrame): Promise<ProtectedVerdict> => {
    const ctx: ProtectedContext = { roots: [...opts.getRoots()], cwd: opts.getCwd() };
    if (opts.realpath) ctx.realpath = opts.realpath;
    try {
      return await checkProtected({ tool: call.tool, args: call.args }, ctx);
    } catch {
      return { protected: true, rule: "unparseable", reason: "could not be checked" };
    }
  };

  const askUser = (call: ToolCallFrame, verdict: { rule: string; reason: string }, signal: AbortSignal): Promise<GateResult> =>
    new Promise<GateResult>((resolve) => {
      const approvalId = newId();
      const onAbort = (): void => {
        settle(approvalId, cancelled("cancelled"));
      };
      const frame: ApprovalOpen = {
        type: "approval",
        requestId: call.runId,
        approvalId,
        callId: call.callId,
        tool: call.tool,
        path: pathOf(call.args, opts.getCwd()),
        reason: verdict.reason,
        rule: verdict.rule,
      };
      if (call.tool === "run_command" && typeof call.args.command === "string") frame.command = call.args.command;
      const timer = timers.setTimeout(() => {
        settle(approvalId, deny("approval timed out"));
      }, approvalTimeoutMs);
      pending.set(approvalId, { callId: call.callId, resolve, timer, onAbort, signal });
      signal.addEventListener("abort", onAbort, { once: true });
      opts.onWaiting?.(call.callId, true);
      opts.onPendingChange?.(pending.size);
      if (!opts.send(frame)) {
        settle(approvalId, cancelled("not connected"));
        return;
      }
    });

  return {
    async gate(call, signal) {
      if (call.approval?.protectedOk === true) return ALLOW;
      // Malformed args never reach a handler: the registry rejects them as invalid_args first, so
      // there is nothing to approve (and no approval card for a bad request).
      if (!validateArgs(call.tool, call.args).ok) return ALLOW;
      if (signal.aborted) return cancelled("cancelled");
      const verdict = await verdictOf(call);
      if (!verdict.protected) return ALLOW;
      if (signal.aborted) return cancelled("cancelled");
      return askUser(call, verdict, signal);
    },
    handleReply(frame) {
      if (frame.decision === "allowed-once") return settle(frame.approvalId, ALLOW);
      return settle(frame.approvalId, deny("rejected by the user"));
    },
    cancelAll() {
      for (const id of [...pending.keys()]) settle(id, cancelled("cancelled"));
    },
    pendingCount() {
      return pending.size;
    },
  };
}
