/**
 * Applies the chat frames the server sends (prompt_ack, models, conversations, transcript,
 * approval_mode, error) to the controller state. Pure: no `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import type { ChatError, ChatErrorCode } from "./controllerTypes";
import { toError } from "./controllerTypes";
import type { PendingKind, RequestTracker, RunTracker } from "./pending";
import type { ChatState } from "./state";
import { applyTranscript } from "./transcript";

/** Frame types the controller consumes. */
export const CHAT_S_TYPES: ReadonlySet<string> = new Set([
  "prompt_ack",
  "models",
  "conversations",
  "transcript",
  "approval_mode",
  "error",
]);

const MAX_CACHED_CONVERSATIONS = 20;

export interface InboundDeps {
  pending: RequestTracker;
  runs: RunTracker;
  /** Asks for the conversation list again (a run was acknowledged, so a new one may exist). */
  refreshConversations: () => void;
}

/** Applies an error to the state a request belongs to. Used for timeouts and server errors. */
export function settle(
  st: ChatState,
  kind: PendingKind,
  conversation: string | undefined,
  requestId: string,
  err: ChatError,
): void {
  if (kind === "prompt" && st.awaitingAck === requestId) st.awaitingAck = null;
  if (kind === "models") st.modelsState = "error";
  if (kind === "conversations") st.conversationsState = "error";
  if (kind === "conversation" && conversation === st.conversationId) st.loadingConversation = false;
  st.error = err;
}

/** Stores a transcript and keeps only the most recently used conversations. */
export function remember(st: ChatState, id: string, list: TranscriptItem[]): void {
  st.transcripts.delete(id); // re-insert so the Map keeps recently used conversations last
  st.transcripts.set(id, list);
  while (st.transcripts.size > MAX_CACHED_CONVERSATIONS) {
    const oldest = st.transcripts.keys().next().value as string;
    if (oldest === st.conversationId) break;
    st.transcripts.delete(oldest);
  }
}

/** Handles one server frame. Returns false when the frame is not a chat frame the controller uses. */
export function handleInbound(frame: Frame, st: ChatState, deps: InboundDeps): boolean {
  switch (frame.type) {
    case "prompt_ack": {
      if (frame.requestId !== st.awaitingAck) return true; // stale or already timed out
      deps.pending.untrack(frame.requestId);
      st.awaitingAck = null;
      if (!frame.ok) {
        st.error = toError(frame.error, frame.message);
        return true;
      }
      const id = frame.conversationId;
      const baseline = (st.transcripts.get(id) ?? []).length;
      st.conversationId = id;
      if (!st.transcripts.has(id)) remember(st, id, []);
      deps.runs.start(id, baseline);
      st.error = null;
      deps.refreshConversations();
      return true;
    }
    case "models":
      st.models = frame.items;
      st.defaultModel = frame.defaultRef ?? null;
      if (st.model !== null && !st.models.some((m) => m.ref === st.model)) st.model = null;
      deps.pending.untrack(frame.requestId);
      st.modelsState = "ready";
      return true;
    case "conversations":
      st.conversations = [...frame.items].sort((a, b) => b.updatedAt - a.updatedAt);
      deps.pending.untrack(frame.requestId);
      st.conversationsState = "ready";
      return true;
    case "transcript": {
      const id = frame.conversationId;
      deps.pending.drop((r) => r.kind === "conversation" && r.conversationId === id);
      const next = applyTranscript(st.transcripts.get(id) ?? [], frame);
      remember(st, id, next);
      if (frame.reset === true && id === st.conversationId) st.loadingConversation = false;
      // A conversation started elsewhere (or before the ack arrived) becomes current if none is open.
      if (st.conversationId === null && st.awaitingAck !== null) st.conversationId = id;
      deps.runs.observe(id, next);
      return true;
    }
    case "approval_mode":
      if (frame.ok) {
        if (frame.conversationId === st.conversationId) st.approvalMode = frame.mode;
      } else {
        st.error = { code: (frame.error === "confirm_required" ? "confirm_required" : "generic") as ChatErrorCode };
      }
      return true;
    case "error": {
      const requestId = frame.requestId;
      if (requestId === undefined) return false;
      const request = deps.pending.untrack(requestId);
      if (request === undefined) return false; // unknown or already settled
      settle(st, request.kind, request.conversationId, requestId, toError(frame.code, frame.message));
      return true;
    }
    default:
      return false;
  }
}
