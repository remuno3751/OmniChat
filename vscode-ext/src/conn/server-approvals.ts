/**
 * Server-originated approvals shown in VS Code (spec docs/design/VSCODE-BRIDGE.md §4.4).
 * `approval_pending` (S -> E) opens a card; the user's answer goes back as `approval_decision` (E -> S);
 * `approval_settled` (S -> E) closes it, however it was decided. None of these resolve an
 * extension-originated gate (./escalation.ts): only the server's `approval_reply` does that.
 */
import type { ApprovalDecisionFrame, ApprovalPendingFrame, Frame } from "../protocol/frames";
import type { ApprovalInput } from "../ui/approvalModel";

export interface ServerApprovalsOptions {
  send: (frame: Frame) => boolean;
  show: (input: ApprovalInput) => void;
  dismiss: (approvalId: string) => void;
  /** The number of pending server approvals changed. */
  onCount: (count: number) => void;
}

export interface ServerApprovals {
  /** An `approval_pending` arrived: show its card. A repeated approvalId is ignored. */
  pending(frame: ApprovalPendingFrame): void;
  /** An `approval_settled` arrived, or the card is closed locally. */
  settled(approvalId: string): void;
  /**
   * The user answered the card. Sends `approval_decision` (`allowed-once` -> `once`, anything else -> `deny`).
   * Returns false when the approval was no longer pending (the first answer wins).
   */
  answer(approvalId: string, decision: "allowed-once" | "rejected"): boolean;
  /** Closes every card: cancel, done, disconnect. */
  cancelAll(): void;
  pendingCount(): number;
}

/** The card's view of an `approval_pending`. The frame has no path or call id, so `summary` stands in for the path. */
export function toApprovalInput(frame: ApprovalPendingFrame): ApprovalInput {
  return {
    type: "approval",
    requestId: frame.runId,
    approvalId: frame.approvalId,
    callId: "",
    tool: frame.tool,
    path: frame.summary,
    reason: frame.reasons.join("; ") || frame.summary,
    protected: frame.protected,
    protectedReasons: frame.reasons,
  };
}

export function createServerApprovals(opts: ServerApprovalsOptions): ServerApprovals {
  const pending = new Map<string, ApprovalPendingFrame>();

  /** Removes one card. False if it was not pending. */
  const drop = (approvalId: string): boolean => {
    if (!pending.delete(approvalId)) return false;
    opts.dismiss(approvalId);
    opts.onCount(pending.size);
    return true;
  };

  return {
    pending(frame) {
      if (pending.has(frame.approvalId)) return;
      pending.set(frame.approvalId, frame);
      opts.show(toApprovalInput(frame));
      opts.onCount(pending.size);
    },
    settled(approvalId) {
      drop(approvalId);
    },
    answer(approvalId, decision) {
      if (!pending.has(approvalId)) return false;
      const frame: ApprovalDecisionFrame = {
        type: "approval_decision",
        approvalId,
        decision: decision === "allowed-once" ? "once" : "deny",
      };
      drop(approvalId);
      opts.send(frame);
      return true;
    },
    cancelAll() {
      for (const id of [...pending.keys()]) drop(id);
    },
    pendingCount() {
      return pending.size;
    },
  };
}
