/**
 * Mutable state of the chat controller, shared by controller.ts (user actions) and inbound.ts
 * (server frames). No `vscode` import.
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
import type { ChatError, ListState, ServerInfo } from "./controllerTypes";

export interface ChatState {
  online: boolean;
  seq: number;
  cwd: string | null;
  serverInfo: ServerInfo | null;
  models: ModelItem[];
  defaultModel: string | null;
  /** Selected model ref, or null for the server default. */
  model: string | null;
  modelsState: ListState;
  approvalMode: ApprovalModeId;
  fullConfirmed: boolean;
  conversations: ConversationSummary[];
  conversationsState: ListState;
  conversationId: string | null;
  loadingConversation: boolean;
  /** Transcript per conversation, most recently used last. */
  transcripts: Map<string, TranscriptItem[]>;
  /** requestId of the prompt waiting for its ack. */
  awaitingAck: string | null;
  error: ChatError | null;
  /** Search policy for the next prompt; null inherits the conversation's stored mode. */
  searchMode: SearchMode | null;
  /** Prompts written while a run was active, sent in order when it ends. */
  queue: QueuedPrompt[];
  /** Usage of the open conversation, from the last `context` frame. */
  context: ContextUsage | null;
  /** Bridges online, from the last `devices` frame. */
  devices: { state: ListState; items: DeviceItem[] };
  /** Settings of `conversationId` (null: none asked yet). */
  settings: { conversationId: string | null; state: ListState; value: ConversationSettings | null };
  /** The last history search: its text, state and hits (at most 30). */
  search: { query: string; state: ListState; hits: SearchHit[] };
  /** The checkpoint list of the open conversation (v0.5.6-E). */
  checkpoints: CheckpointsState;
}

/**
 * Checkpoints of one conversation (v0.5.6-E). `restoring` is the id being restored, if any.
 * `error` means the list could not be read.
 */
export interface CheckpointsState {
  conversationId: string | null;
  state: ListState;
  items: CheckpointItem[];
  restoring: string | null;
  error: boolean;
}

/** A prompt waiting in the queue. `conversationId` is where it was written (null: a new conversation). */
export interface QueuedPrompt {
  id: string;
  text: string;
  conversationId: string | null;
  attachments: PromptAttachment[];
}

export interface ContextUsage extends ContextBreakdownFields {
  total: number;
  limit: number;
  fits: boolean;
  estimated: boolean;
}

export function createState(): ChatState {
  return {
    online: false,
    seq: 0,
    cwd: null,
    serverInfo: null,
    models: [],
    defaultModel: null,
    model: null,
    modelsState: "idle",
    approvalMode: "manual",
    fullConfirmed: false,
    conversations: [],
    conversationsState: "idle",
    conversationId: null,
    loadingConversation: false,
    transcripts: new Map(),
    awaitingAck: null,
    error: null,
    searchMode: null,
    queue: [],
    context: null,
    devices: { state: "idle", items: [] },
    settings: { conversationId: null, state: "idle", value: null },
    search: { query: "", state: "idle", hits: [] },
    checkpoints: { conversationId: null, state: "idle", items: [], restoring: null, error: false },
  };
}

/** Items of the open conversation (empty when none is open). */
export function currentItems(st: ChatState): TranscriptItem[] {
  return st.conversationId ? (st.transcripts.get(st.conversationId) ?? []) : [];
}
