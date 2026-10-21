import type { ChatEFrame, ChatSFrame } from "./chat-frames";
export type * from "./chat-frames";

// Wire frame types for the VS Code extension <-> server bridge.
// See docs/design/VSCODE-BRIDGE.md §2. Every frame is discriminated by `type`.
// E = extension (VS Code), S = server.

/** Tool names a bridge may advertise in `ready.capabilities.tools`. */
export type ToolName =
  | "read_file"
  | "list_dir"
  | "glob"
  | "grep"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "get_diagnostics"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_commit";

export type ToolArgs = Record<string, unknown>;

/** Approval basis carried by a `tool_call`. A `tool_call` without `approval` is denied. */
export interface ToolApproval {
  by: "mode:manual" | "user" | `rule:${string}`;
  protectedOk: boolean;
}

/** A tool invocation sent S -> E (payload part of the `tool_call` frame). */
export interface ToolCall {
  runId: string;
  callId: string;
  tool: ToolName;
  args: ToolArgs;
  approval?: ToolApproval;
  timeoutMs: number;
}

export interface ToolErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

/** Outcome of a tool call (payload part of the `tool_result` frame). */
export type ToolResult =
  | { ok: true; result: unknown; truncated: boolean; durationMs: number }
  | { ok: false; error: ToolErrorInfo };

export interface ToolProgressEvent {
  type: "tool_progress";
  callId: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** Events that may be wrapped in an `event` frame. */
export type BridgeEvent = ToolProgressEvent;

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface BridgeCapabilities {
  workspaces: boolean;
  fs: boolean;
  approval: boolean;
  checkpoints: boolean;
  transcript: boolean;
  /** Extension 0.2.0+: this window can chat (prompt, models, conversations, transcript). */
  chat?: boolean;
  tools: ToolName[];
}

// ---------------------------------------------------------------------------
// E -> S
// ---------------------------------------------------------------------------

export interface ReadyFrame {
  type: "ready";
  kind: "vscode";
  name: string;
  instance: string;
  version: string;
  protocol: number;
  vscodeVersion: string;
  platform: string;
  shell: string;
  remote: "ssh-remote" | "wsl" | "dev-container" | null;
  cwd: string;
  workspaces: string[];
  allowAnyCwd: boolean;
  trusted: boolean;
  capabilities: BridgeCapabilities;
}

export interface WorkspacesFrame {
  type: "workspaces";
  workspaces: string[];
  allowAnyCwd: boolean;
}

export interface RunAckFrame {
  type: "run_ack";
  runId: string;
  ok: boolean;
  error?: "busy" | "cwd not allowed" | "untrusted_workspace";
}

export type CheckpointFrame =
  | {
      type: "checkpoint";
      requestId: string;
      checkpointId: string;
      ref: string;
      createdAt: number;
      dirty: boolean;
    }
  | {
      type: "checkpoint";
      requestId: string;
      unavailable: string;
    };

export interface BridgeEventFrame {
  type: "event";
  runId: string;
  event: BridgeEvent;
}

export type ToolResultFrame = {
  type: "tool_result";
  runId: string;
  callId: string;
} & ToolResult;

export interface ApprovalFrame {
  type: "approval";
  requestId: string;
  approvalId: string;
  callId: string;
  tool: ToolName;
  path: string;
  reason: string;
}

/** Extension's answer to a server-originated `approval_pending` (spec §4.4). First answer wins. */
export interface ApprovalDecisionFrame {
  type: "approval_decision";
  approvalId: string;
  decision: "once" | "deny";
}

export interface ChangesFrame {
  type: "changes";
  requestId: string;
  changes: FileChange[];
  truncated: boolean;
}

export interface DoneFrame {
  type: "done";
  runId: string;
  ok: boolean;
  error?: string;
  warning?: string;
}

export interface RewoundFrame {
  type: "rewound";
  requestId: string;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// S -> E
// ---------------------------------------------------------------------------

export interface WelcomeFrame {
  type: "welcome";
  protocol: number;
  serverVersion: string;
  minExtensionVersion: string;
  /** Optional capability list (the server sends ["chat"] from 0.5.4-beta.2). Absent on older servers. */
  features?: string[];
}

export interface RunFrame {
  type: "run";
  runId: string;
  conversationId: string;
  cwd: string;
  approvalMode: string;
  checkpoint: boolean;
  roots: string[];
}

export type ToolCallFrame = {
  type: "tool_call";
} & ToolCall;

export interface CancelFrame {
  type: "cancel";
  runId: string;
}

export interface ApprovalReplyFrame {
  type: "approval_reply";
  approvalId: string;
  decision: "allowed-once" | "rejected";
}

/**
 * Server-originated approval shown in VS Code (spec §4.4, only when `capabilities.approval` is true).
 * The panel answers with `approval_decision`. It never resolves an extension-originated `approval`.
 */
export interface ApprovalPendingFrame {
  type: "approval_pending";
  runId: string;
  approvalId: string;
  tool: ToolName;
  summary: string;
  protected: boolean;
  reasons: string[];
}

/** Closes a pending `approval_pending` card, decided anywhere (spec §4.4). Extra fields are ignored. */
export interface ApprovalSettledFrame {
  type: "approval_settled";
  approvalId: string;
  decision: string;
  decidedBy: string;
}

export interface RunEndFrame {
  type: "run_end";
  runId: string;
}

export interface RewindFrame {
  type: "rewind";
  requestId: string;
  ref: string;
  cwd: string;
  removeNew: boolean;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export type EFrame =
  | ReadyFrame
  | WorkspacesFrame
  | RunAckFrame
  | CheckpointFrame
  | BridgeEventFrame
  | ToolResultFrame
  | ApprovalFrame
  | ApprovalDecisionFrame
  | ChangesFrame
  | DoneFrame
  | RewoundFrame
  | ChatEFrame;

export type SFrame =
  | WelcomeFrame
  | RunFrame
  | ToolCallFrame
  | CancelFrame
  | ApprovalReplyFrame
  | ApprovalPendingFrame
  | ApprovalSettledFrame
  | RunEndFrame
  | RewindFrame
  | ChatSFrame;

export type Frame = EFrame | SFrame;

export type FrameType = Frame["type"];
