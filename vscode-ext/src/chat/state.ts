/**
 * Mutable state of the chat controller, shared by controller.ts (user actions) and inbound.ts
 * (server frames). No `vscode` import.
 */
import type { ApprovalModeId, ConversationSummary, ModelItem, TranscriptItem } from "../protocol/chat-frames";
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
  };
}

/** Items of the open conversation (empty when none is open). */
export function currentItems(st: ChatState): TranscriptItem[] {
  return st.conversationId ? (st.transcripts.get(st.conversationId) ?? []) : [];
}
