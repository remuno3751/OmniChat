/**
 * Public types of the chat controller: the snapshot the view reads, the error codes, and the
 * controller options. Split out of controller.ts to keep that file small. No `vscode` import.
 */
import type {
  ApprovalModeId,
  CheckpointItem,
  ContextBreakdownFields,
  ConversationSettings,
  ConversationSummary,
  DeviceItem,
  ModelItem,
  PromptAttachment,
  SearchHit,
  SearchMode,
  TranscriptItem,
} from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import type { SettingsInput } from "./chatSettings";
import type { CheckpointsState, ContextUsage } from "./state";
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
  | "invalid_frame"
  | "attachment_invalid"
  | "attachment_too_large"
  | "attachment_not_supported";

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
  "attachment_invalid",
  "attachment_too_large",
  "attachment_not_supported",
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

/** Loading state of a list (models, conversations, devices). */
export type ListState = "idle" | "loading" | "ready" | "error";

/** Result of a compact request: the token counts, or a failure (server error or timeout). */
export type CompactOutcome = { ok: true; before: number; after: number } | { ok: false };

/** Settings of the open conversation: `value` is null until a `conversation_settings` frame arrives. */
export interface SettingsView {
  state: ListState;
  value: ConversationSettings | null;
}

/** The history search: `query` is the trimmed text searched, `hits` at most 30. */
export interface SearchView {
  query: string;
  state: ListState;
  hits: SearchHit[];
}

/** Result of a checkpoint restore: `ok`, or the server's reason (`error`, `message`), or "timeout". */
export interface RestoreOutcome {
  ok: boolean;
  checkpointId: string;
  error?: string;
  message?: string;
}

/** The checkpoint calls of the controller (v0.5.6-E). */
export interface CheckpointApi {
  /** Asks for the checkpoints of the open conversation; the list lands in `snapshot().checkpoints`. */
  request(): void;
  /** Asks to restore to a checkpoint. False when nothing was sent (offline, no conversation, a restore is running). */
  restore(checkpointId: string, removeNew: boolean, onResult: (r: RestoreOutcome) => void): boolean;
  /** Adds a local status line to the end of the open transcript (not sent to the server). */
  appendStatus(text: string): void;
}

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
  /** Search policy for the next prompt; null means the conversation's stored mode. */
  searchMode: SearchMode | null;
  /** Prompts waiting for the active run to end, oldest first. */
  queue: Array<{ id: string; text: string }>;
  /** Context usage of the open conversation; null when unknown. `used`, `reasoning` and `last` when the server sent them. */
  context: (ContextUsage & ContextBreakdownFields) | null;
  /** The user's online bridges, as the last `devices` frame listed them. */
  devices: { state: ListState; items: DeviceItem[] };
  /** Settings of the open conversation ("this chat"). */
  settings: SettingsView;
  /** The last history search. */
  search: SearchView;
  /** Checkpoints of the open conversation (v0.5.6-E). */
  checkpoints: CheckpointsState;
}

export interface ChatControllerOptions {
  /** Clock in ms for the double-click guard. Default Date.now. */
  now?: () => number;
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
  /**
   * Sends a prompt. While a run is active it is queued (max 10) and sent when the run ends;
   * `interrupt` sends it at once with interrupt:true. False when nothing was taken (offline, empty,
   * a duplicate within 300 ms, a full queue, or a failed send).
   */
  sendPrompt(text: string, opts?: { interrupt?: boolean; attachments?: PromptAttachment[]; replaceLast?: boolean }): boolean;
  cancelQueued(id: string): void;
  setSearchMode(mode: SearchMode | null): void;
  /** The draft changed: refreshes the context meter after 800 ms of quiet. */
  draftChanged(): void;
  stop(): void;
  newConversation(): void;
  openConversation(id: string): void;
  setModel(ref: string | null): void;
  /** `confirmFull` must be true when switching to `full` after the user confirmed. */
  setApprovalMode(mode: ApprovalModeId, confirmFull?: boolean): void;
  setCwd(cwd: string): void;
  clearError(): void;
  /** Asks which bridges are online; the answer lands in `snapshot().devices`. */
  requestDevices(): void;
  /**
   * Asks the server to compact the open conversation. `onResult` is called once: with the token
   * counts, or with ok:false (no conversation, offline, server error, timeout).
   */
  compact(onResult?: (r: CompactOutcome) => void): void;
  /** Refreshes the context meter now. `onUsage` is called once with the answer, if one comes. */
  refreshContext(onUsage?: (usage: ContextUsage) => void): void;
  /** Asks for the settings of the open conversation; the answer lands in `snapshot().settings`. */
  requestSettings(): void;
  /** Saves settings and/or the title of the open conversation. `onResult` is called once (false when not sent). */
  saveSettings(input: SettingsInput, onResult?: (ok: boolean) => void): void;
  /** Searches every conversation of this bridge; the answer lands in `snapshot().search`. */
  searchHistory(query: string): void;
  /** Checkpoint list and restore (v0.5.6-E). */
  checkpoints: CheckpointApi;
  /** Clears every pending timer. Call when the view goes away. */
  dispose(): void;
}
