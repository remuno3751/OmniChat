// Chat frames (extension 0.2.0, advertised as `capabilities.chat` and `capabilities.transcript`).
// All additive: unknown fields are ignored and older servers never send these.
// E = extension (VS Code), S = server.
// The v0.5.5-beta.2 frames and fields live in chat-frames-v055.ts, re-exported here.

import { isValidCompactedFrame, isValidContextBreakdown, isValidDevicesFrame, isValidModelExtras } from "./chat-frames-v055";
import type { CompactedFrame, CompactRequestFrame, ContextBreakdownFields, DevicesFrame, DevicesRequestFrame, PromptAttachment, VisionState } from "./chat-frames-v055";
export * from "./chat-frames-v055";
export * from "./chat-frames-v056d";
import { isValidV056dSFrame } from "./chat-validate-v056d";
import type {
  ConversationSettingsAckFrame,
  ConversationSettingsFrame,
  ConversationSettingsRequestFrame,
  ConversationSettingsSetFrame,
  HistorySearchFrame,
  HistorySearchRequestFrame,
} from "./chat-frames-v056d";
import { isValidCheckpointRestoredFrame, isValidCheckpointsFrame } from "./chat-frames-v056e";
import type { CheckpointRestoredFrame, CheckpointRestoreFrame, CheckpointsFrame, CheckpointsRequestFrame } from "./chat-frames-v056e";
export * from "./chat-frames-v056e";
import type { AssistantStatus, ToolItemStatus, ToolDiff, TranscriptItem, TranscriptFrame } from "./chat-frames-transcript";
export * from "./chat-frames-transcript";

export type ApprovalModeId = "manual" | "auto" | "full";
export const APPROVAL_MODES: readonly ApprovalModeId[] = ["manual", "auto", "full"];

/** Web search policy of a conversation (same column as the app uses). */
export type SearchMode = "off" | "smart" | "always";
export const SEARCH_MODES: readonly SearchMode[] = ["off", "smart", "always"];

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
  /** Absent keeps the conversation's stored mode. */
  searchMode?: SearchMode;
  /** True: stop the active run in this conversation first, then run this prompt. */
  interrupt?: boolean;
  /** Absent when the prompt has no files. */
  attachments?: PromptAttachment[];
  /** v0.5.6-E: replace the last user message (and what followed it) of `conversationId` with this prompt. */
  replaceLast?: true;
}

/** Asks for the context usage of a conversation. Answered by a `context` frame (or `error` with the requestId). */
export interface ContextRequestFrame {
  type: "context_request";
  requestId: string;
  conversationId: string;
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
  /** Context window in tokens, from the provider's model state. Absent when unknown. */
  contextLength?: number;
  vision?: VisionState;
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
  /** Absent from servers before v0.5.5. */
  searchMode?: SearchMode;
}

/** Context usage: tokens used against the model limit. `limit` 0 means unknown. The breakdown fields are optional. */
export interface ContextFrame extends ContextBreakdownFields {
  type: "context";
  requestId: string;
  total: number;
  limit: number;
  fits: boolean;
  estimated: boolean;
}

export interface ConversationsFrame {
  type: "conversations";
  requestId: string;
  items: ConversationSummary[];
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
  | StopFrame
  | ContextRequestFrame
  | DevicesRequestFrame
  | CompactRequestFrame
  | ConversationSettingsRequestFrame
  | ConversationSettingsSetFrame
  | HistorySearchRequestFrame
  | CheckpointsRequestFrame
  | CheckpointRestoreFrame;

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
  | ContextFrame
  | DevicesFrame
  | CompactedFrame
  | ErrorFrame
  | ConversationSettingsFrame
  | ConversationSettingsAckFrame
  | HistorySearchFrame
  | CheckpointsFrame
  | CheckpointRestoredFrame;

// ---------------------------------------------------------------------------
// Validation (S -> E only; the extension builds its own E -> S frames).
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const isMode = (v: unknown): v is ApprovalModeId => APPROVAL_MODES.includes(v as ApprovalModeId);
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";
const isDiff = (v: unknown): boolean =>
  isRec(v) &&
  isStr(v.path) &&
  typeof v.added === "number" &&
  typeof v.removed === "number" &&
  (v.truncated === undefined || typeof v.truncated === "boolean") &&
  Array.isArray(v.lines) &&
  v.lines.every(isStr);

const ASSISTANT_STATUS: readonly unknown[] = ["streaming", "done", "error", "stopped"];
const TOOL_STATUS: readonly unknown[] = ["pending", "running", "done", "error", "denied"];

function validItem(item: unknown): boolean {
  if (!isRec(item)) return false;
  switch (item.kind) {
    case "user":
      return isNonEmpty(item.id) && isStr(item.text);
    case "assistant":
      return (
        isNonEmpty(item.id) &&
        isStr(item.text) &&
        optStr(item.reasoning) &&
        ASSISTANT_STATUS.includes(item.status) &&
        optNum(item.from) &&
        optNum(item.reasoningFrom)
      );
    case "tool":
      return (
        isNonEmpty(item.id) &&
        isStr(item.tool) &&
        isStr(item.summary) &&
        TOOL_STATUS.includes(item.status) &&
        optStr(item.decidedBy) &&
        (item.durationMs === undefined || typeof item.durationMs === "number") &&
        (item.diff === undefined || isDiff(item.diff))
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
        frame.items.every((m) => isRec(m) && isNonEmpty(m.ref) && isStr(m.label) && isStr(m.provider) && isValidModelExtras(m)) &&
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
            isStr(c.cwd) &&
            (c.searchMode === undefined || SEARCH_MODES.includes(c.searchMode as SearchMode)),
        )
      );
    case "transcript":
      return isNonEmpty(frame.conversationId) && Array.isArray(frame.items) && frame.items.every(validItem);
    case "approval_mode":
      if (!isNonEmpty(frame.conversationId) || typeof frame.ok !== "boolean") return false;
      return frame.ok ? isMode(frame.mode) : isNonEmpty(frame.error);
    case "context":
      return (
        isNonEmpty(frame.requestId) &&
        typeof frame.total === "number" &&
        typeof frame.limit === "number" &&
        typeof frame.fits === "boolean" &&
        typeof frame.estimated === "boolean" &&
        isValidContextBreakdown(frame)
      );
    case "devices":
      return isValidDevicesFrame(frame);
    case "compacted":
      return isValidCompactedFrame(frame);
    case "checkpoints":
      return isValidCheckpointsFrame(frame);
    case "checkpoint_restored":
      return isValidCheckpointRestoredFrame(frame);
    case "error":
      return isNonEmpty(frame.code) && optStr(frame.message) && optStr(frame.requestId);
    default:
      return isValidV056dSFrame(frame);
  }
}
