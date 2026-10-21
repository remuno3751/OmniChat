// Chat frames (extension 0.2.0, advertised as `capabilities.chat` and `capabilities.transcript`).
// All additive: unknown fields are ignored and older servers never send these.
// E = extension (VS Code), S = server.

export type ApprovalModeId = "manual" | "auto" | "full";
export const APPROVAL_MODES: readonly ApprovalModeId[] = ["manual", "auto", "full"];

export type AssistantStatus = "streaming" | "done" | "error" | "stopped";
export type ToolItemStatus = "pending" | "running" | "done" | "error" | "denied";

// ---------------------------------------------------------------------------
// E -> S
// ---------------------------------------------------------------------------

export interface PromptFrame {
  type: "prompt";
  requestId: string;
  cwd: string;
  text: string;
  conversationId?: string;
  /** `<providerId>::<modelId>` */
  model?: string;
  approvalMode?: ApprovalModeId;
  confirmFull?: boolean;
}

export interface ModelsRequestFrame {
  type: "models_request";
  requestId: string;
}

export interface ConversationsRequestFrame {
  type: "conversations_request";
  requestId: string;
  cwd: string;
}

/** Asks for the full transcript of one conversation. The answer is a `transcript` with `reset: true`. */
export interface ConversationRequestFrame {
  type: "conversation_request";
  requestId: string;
  conversationId: string;
}

export interface SetApprovalModeFrame {
  type: "set_approval_mode";
  requestId: string;
  conversationId: string;
  mode: ApprovalModeId;
  confirmFull?: boolean;
}

export interface StopFrame {
  type: "stop";
  requestId: string;
  conversationId: string;
}

// ---------------------------------------------------------------------------
// S -> E
// ---------------------------------------------------------------------------

export type PromptAckFrame =
  | { type: "prompt_ack"; requestId: string; ok: true; conversationId: string }
  | { type: "prompt_ack"; requestId: string; ok: false; error: string; message?: string };

export interface ModelItem {
  ref: string;
  label: string;
  provider: string;
}

export interface ModelsFrame {
  type: "models";
  requestId: string;
  items: ModelItem[];
  defaultRef?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  approvalMode: ApprovalModeId;
  cwd: string;
}

export interface ConversationsFrame {
  type: "conversations";
  requestId: string;
  items: ConversationSummary[];
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning?: string; status: AssistantStatus }
  | {
      kind: "tool";
      id: string;
      tool: string;
      summary: string;
      status: ToolItemStatus;
      decidedBy?: string;
      durationMs?: number;
    }
  | { kind: "status"; id?: string; text: string };

/** Streaming re-sends the same item id with the full new text. `reset` replaces the transcript. */
export interface TranscriptFrame {
  type: "transcript";
  conversationId: string;
  runId?: string;
  reset?: boolean;
  items: TranscriptItem[];
}

export type ApprovalModeFrame =
  | { type: "approval_mode"; conversationId: string; mode: ApprovalModeId; ok: true }
  | { type: "approval_mode"; conversationId: string; mode?: ApprovalModeId; ok: false; error: string };

export type ChatEFrame =
  | PromptFrame
  | ModelsRequestFrame
  | ConversationsRequestFrame
  | ConversationRequestFrame
  | SetApprovalModeFrame
  | StopFrame;

/** The server rejected a request. `requestId` echoes the request when there is one. */
export interface ErrorFrame {
  type: "error";
  code: string;
  message?: string;
  requestId?: string;
}

export type ChatSFrame =
  | PromptAckFrame
  | ModelsFrame
  | ConversationsFrame
  | TranscriptFrame
  | ApprovalModeFrame
  | ErrorFrame;

// ---------------------------------------------------------------------------
// Validation (S -> E only; the extension builds its own E -> S frames).
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const isMode = (v: unknown): v is ApprovalModeId => APPROVAL_MODES.includes(v as ApprovalModeId);
const optStr = (v: unknown): boolean => v === undefined || isStr(v);

const ASSISTANT_STATUS: readonly unknown[] = ["streaming", "done", "error", "stopped"];
const TOOL_STATUS: readonly unknown[] = ["pending", "running", "done", "error", "denied"];

function validItem(item: unknown): boolean {
  if (!isRec(item)) return false;
  switch (item.kind) {
    case "user":
      return isNonEmpty(item.id) && isStr(item.text);
    case "assistant":
      return isNonEmpty(item.id) && isStr(item.text) && optStr(item.reasoning) && ASSISTANT_STATUS.includes(item.status);
    case "tool":
      return (
        isNonEmpty(item.id) &&
        isStr(item.tool) &&
        isStr(item.summary) &&
        TOOL_STATUS.includes(item.status) &&
        optStr(item.decidedBy) &&
        (item.durationMs === undefined || typeof item.durationMs === "number")
      );
    case "status":
      return isStr(item.text) && optStr(item.id);
    default:
      return false;
  }
}

/**
 * True when `frame` (already known to be an object with a known `type`) is well formed.
 * Types that are not chat S -> E frames always pass. Unknown fields never fail a frame.
 */
export function isValidChatSFrame(frame: Rec): boolean {
  switch (frame.type) {
    case "prompt_ack":
      if (!isNonEmpty(frame.requestId) || typeof frame.ok !== "boolean") return false;
      return frame.ok ? isNonEmpty(frame.conversationId) : isNonEmpty(frame.error);
    case "models":
      return (
        isNonEmpty(frame.requestId) &&
        Array.isArray(frame.items) &&
        frame.items.every((m) => isRec(m) && isNonEmpty(m.ref) && isStr(m.label) && isStr(m.provider)) &&
        optStr(frame.defaultRef)
      );
    case "conversations":
      return (
        isNonEmpty(frame.requestId) &&
        Array.isArray(frame.items) &&
        frame.items.every(
          (c) =>
            isRec(c) &&
            isNonEmpty(c.id) &&
            isStr(c.title) &&
            typeof c.updatedAt === "number" &&
            isMode(c.approvalMode) &&
            isStr(c.cwd),
        )
      );
    case "transcript":
      return isNonEmpty(frame.conversationId) && Array.isArray(frame.items) && frame.items.every(validItem);
    case "approval_mode":
      if (!isNonEmpty(frame.conversationId) || typeof frame.ok !== "boolean") return false;
      return frame.ok ? isMode(frame.mode) : isNonEmpty(frame.error);
    case "error":
      return isNonEmpty(frame.code) && optStr(frame.message) && optStr(frame.requestId);
    default:
      return true;
  }
}
