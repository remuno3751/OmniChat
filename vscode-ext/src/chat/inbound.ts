/**
 * Applies the chat frames the server sends (prompt_ack, models, conversations, transcript,
 * approval_mode, error) to the controller state. Pure: no `vscode` import.
 */
import { contextBreakdownOf, MAX_SEARCH_RESULTS, type TranscriptItem } from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import type { ChatError, ChatErrorCode, RestoreOutcome } from "./controllerTypes";
import { toError } from "./controllerTypes";
import { retitle } from "./chatSettings";
import { settleCheckpoints } from "./checkpointRequests";
import type { PendingKind, PendingRequest, RequestTracker, RunTracker } from "./pending";
import type { ChatState } from "./state";
import { applyTranscriptChecked } from "./transcript";

/** Frame types the controller consumes. */
export const CHAT_S_TYPES: ReadonlySet<string> = new Set([
  "prompt_ack",
  "models",
  "conversations",
  "transcript",
  "approval_mode",
  "context",
  "error",
  "devices",
  "compacted",
  "conversation_settings",
  "conversation_settings_ack",
  "history_search",
  "checkpoints",
  "checkpoint_restored",
]);

const MAX_CACHED_CONVERSATIONS = 20;
/** Least time between two resyncs of the same conversation after stale deltas. */
const RESYNC_MIN_GAP_MS = 1000;

export interface InboundDeps {
  pending: RequestTracker;
  runs: RunTracker;
  /** Asks for the conversation list again (a run was acknowledged, so a new one may exist). */
  refreshConversations: () => void;
  /** Asks for the full transcript of a conversation whose delta did not apply. Throttled by the caller. */
  resync: (conversationId: string) => void;
  /** Asks for the settings of the open conversation when they are missing (a conversation was opened). */
  ensureSettings: () => void;
}

/**
 * Applies an error to the state a request belongs to. Used for timeouts and server errors.
 * Context and compact failures stay quiet here (the callers of those requests decide what to show).
 */
export function settle(
  st: ChatState,
  kind: PendingKind,
  conversation: string | undefined,
  requestId: string,
  err: ChatError,
): void {
  if (kind === "context" || kind === "compact") return;
  if (kind === "checkpoints" || kind === "checkpoint_restore") return settleCheckpoints(st, kind, conversation);
  if (kind === "devices") {
    st.devices = { state: "error", items: [] };
    return;
  }
  // Settings and search show their own error states; the save toast is the caller's.
  if (kind === "settings") {
    if (conversation !== undefined && conversation === st.settings.conversationId) {
      st.settings = { conversationId: conversation, state: "error", value: null };
    }
    return;
  }
  if (kind === "settingsSet") return;
  if (kind === "search") {
    st.search = { ...st.search, state: "error", hits: [] };
    return;
  }
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

/**
 * Wraps `request` (which returns false when nothing was sent) so each conversation is asked again at
 * most once per RESYNC_MIN_GAP_MS.
 */
export function throttledResync(request: (id: string) => boolean, now: () => number): (id: string) => void {
  const last = new Map<string, number>();
  return (id) => {
    const at = now();
    const prev = last.get(id);
    if (prev !== undefined && at - prev < RESYNC_MIN_GAP_MS) return;
    if (request(id)) last.set(id, at);
  };
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
      deps.ensureSettings();
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
      const checked = applyTranscriptChecked(st.transcripts.get(id) ?? [], frame);
      const next = checked.items;
      remember(st, id, next);
      if (checked.stale) deps.resync(id);
      if (frame.reset === true && id === st.conversationId) st.loadingConversation = false;
      // A conversation started elsewhere (or before the ack arrived) becomes current if none is open.
      if (st.conversationId === null && st.awaitingAck !== null) st.conversationId = id;
      deps.runs.observe(id, next);
      deps.ensureSettings();
      return true;
    }
    case "approval_mode":
      if (frame.ok) {
        if (frame.conversationId === st.conversationId) st.approvalMode = frame.mode;
      } else {
        st.error = { code: (frame.error === "confirm_required" ? "confirm_required" : "generic") as ChatErrorCode };
      }
      return true;
    case "context": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind === "context" && request.conversationId === st.conversationId) {
        const usage = {
          total: frame.total,
          limit: frame.limit,
          fits: frame.fits,
          estimated: frame.estimated,
          ...contextBreakdownOf(frame),
        };
        st.context = usage;
        request.onUsage?.(usage);
      }
      return true;
    }
    case "devices": {
      if (deps.pending.untrack(frame.requestId) === undefined) return true; // stale: the wait timed out
      st.devices = { state: "ready", items: frame.items };
      return true;
    }
    case "compacted": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind === "compact") request.onCompact?.({ ok: true, before: frame.before, after: frame.after });
      return true;
    }
    case "conversation_settings": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind !== "settings" || frame.conversationId !== st.settings.conversationId) return true;
      st.settings = {
        conversationId: frame.conversationId,
        state: "ready",
        value: { systemPrompt: frame.systemPrompt, systemMode: frame.systemMode, effort: frame.effort },
      };
      retitle(st, frame.conversationId, frame.title);
      return true;
    }
    case "conversation_settings_ack": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind !== "settingsSet") return true; // stale: the wait timed out
      if (!frame.ok) {
        request.onSaved?.(false);
        return true;
      }
      if (frame.settings !== undefined && frame.conversationId === st.settings.conversationId) {
        st.settings = { conversationId: frame.conversationId, state: "ready", value: frame.settings };
      }
      if (frame.title !== undefined) retitle(st, frame.conversationId, frame.title);
      request.onSaved?.(true);
      return true;
    }
    case "history_search": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind !== "search") return true; // stale: a newer search replaced it
      st.search = { query: st.search.query, state: "ready", hits: frame.results.slice(0, MAX_SEARCH_RESULTS) };
      return true;
    }
    case "checkpoints": {
      const request = deps.pending.untrack(frame.requestId);
      if (request?.kind !== "checkpoints") return true; // stale: the wait timed out
      const restoring = st.checkpoints.conversationId === frame.conversationId ? st.checkpoints.restoring : null;
      st.checkpoints = { conversationId: frame.conversationId, state: "ready", items: frame.items, restoring, error: false };
      return true;
    }
    case "checkpoint_restored": {
      const request = deps.pending.untrack(frame.requestId);
      if (st.checkpoints.restoring === frame.checkpointId) st.checkpoints = { ...st.checkpoints, restoring: null };
      const outcome: RestoreOutcome = {
        ok: frame.ok,
        checkpointId: frame.checkpointId,
        ...(frame.error !== undefined ? { error: frame.error } : {}),
        ...(frame.message !== undefined ? { message: frame.message } : {}),
      };
      request?.onRestore?.(outcome);
      return true;
    }
    case "error": {
      const requestId = frame.requestId;
      if (requestId === undefined) return false;
      const request = deps.pending.untrack(requestId);
      if (request === undefined) return false; // unknown or already settled
      request.onCompact?.({ ok: false });
      request.onSaved?.(false);
      request.onRestore?.({ ok: false, checkpointId: "", error: frame.code, ...(frame.message ? { message: frame.message } : {}) });
      settle(st, request.kind, request.conversationId, requestId, toError(frame.code, frame.message));
      return true;
    }
    default:
      return false;
  }
}

/** A request whose answer did not come in time: its callbacks get a timeout, and the state is settled. */
export function expireRequest(st: ChatState, requestId: string, request: PendingRequest, emit: () => void): void {
  request.onCompact?.({ ok: false });
  request.onSaved?.(false);
  request.onRestore?.({ ok: false, checkpointId: "", error: "timeout" });
  settle(st, request.kind, request.conversationId, requestId, { code: "timeout" });
  emit();
}
