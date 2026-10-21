/**
 * Public types of the chat controller: the snapshot the view reads, the error codes, and the
 * controller options. Split out of controller.ts to keep that file small. No `vscode` import.
 */
import type { ApprovalModeId, ConversationSummary, ModelItem, TranscriptItem } from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import type { ChatSupport } from "./support";

export type ChatErrorCode =
  | "generic"
  | "busy"
  | "confirm_required"
  | "not_ready"
  | "send_failed"
  | "timeout"
  | "unsupported"
  | "no_models"
  | "no_model"
  | "forbidden_model"
  | "quota"
  | "workspace_not_open"
  | "outdated"
  | "not_found"
  | "invalid_frame";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ChatErrorCode>([
  "generic",
  "busy",
  "confirm_required",
  "not_ready",
  "send_failed",
  "timeout",
  "unsupported",
  "no_models",
  "no_model",
  "forbidden_model",
  "quota",
  "workspace_not_open",
  "outdated",
  "not_found",
  "invalid_frame",
]);

export interface ChatError {
  code: ChatErrorCode;
  /** Server-provided text, shown as is. Only set for `generic`. */
  message?: string;
}

/** Maps a code from the server to a ChatError: known codes keep their meaning, others become generic. */
export function toError(code: string, message?: string): ChatError {
  return KNOWN_ERROR_CODES.has(code) && code !== "generic"
    ? { code: code as ChatErrorCode }
    : { code: "generic", ...(message ? { message } : {}) };
}

/** Loading state of a list (models, conversations). */
export type ListState = "idle" | "loading" | "ready" | "error";

/** What the server said about itself in its welcome frame. */
export interface ServerInfo {
  serverVersion?: string;
  features?: readonly string[];
}

export interface ChatSnapshot {
  online: boolean;
  cwd: string | null;
  cwds: string[];
  models: ModelItem[];
  /** Selected model ref, or null for the server default. */
  model: string | null;
  defaultModel: string | null;
  /** The model a prompt is sent with: model ?? defaultModel ?? first model, or null. */
  effectiveModel: string | null;
  approvalMode: ApprovalModeId;
  conversations: ConversationSummary[];
  conversationId: string | null;
  items: TranscriptItem[];
  /** sending || running. Kept for compatibility. */
  busy: boolean;
  /** A prompt was sent and its ack is pending. */
  sending: boolean;
  /** A run was acknowledged and has not finished yet. */
  running: boolean;
  error: ChatError | null;
  chatSupport: ChatSupport;
  serverVersion: string | null;
  modelsState: ListState;
  conversationsState: ListState;
  loadingConversation: boolean;
}

export interface ChatControllerOptions {
  /** Sends one frame; false when the connection is not online. */
  send: (frame: Frame) => boolean;
  /** Workspace folder roots, first one is the default cwd. */
  roots: () => readonly string[];
  onChange: () => void;
  /** Timeout for models, conversations and conversation requests. Default 10 s. */
  timeoutMs?: number;
  /** Timeout for a prompt's ack. Default 15 s (the server may take up to 10 s). */
  promptAckTimeoutMs?: number;
  /** Time a run may take to show its first transcript frame. Default 30 s. */
  runStartTimeoutMs?: number;
}

export interface ChatController {
  handleFrame(frame: Frame): boolean;
  /** The connection came online (true) or went away (false). */
  setOnline(online: boolean): void;
  /** Server version and features from the welcome frame; null when unknown. */
  setServerInfo(info: ServerInfo | null): void;
  /** Re-reads models, the conversation list and the current conversation. */
  refresh(): void;
  snapshot(): ChatSnapshot;
  sendPrompt(text: string): boolean;
  stop(): void;
  newConversation(): void;
  openConversation(id: string): void;
  setModel(ref: string | null): void;
  /** `confirmFull` must be true when switching to `full` after the user confirmed. */
  setApprovalMode(mode: ApprovalModeId, confirmFull?: boolean): void;
  setCwd(cwd: string): void;
  clearError(): void;
  /** Clears every pending timer. Call when the view goes away. */
  dispose(): void;
}
