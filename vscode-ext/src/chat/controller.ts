/**
 * Chat state machine for the Chat view: models, conversations for the current folder, the open
 * transcript, the selected approval mode, and the request/response bookkeeping for the chat frames.
 * Every request frame is tracked by requestId with a timer (pending.ts), so a server that never
 * answers resets the state and shows an error instead of spinning forever.
 * Pure: frames go out through `send`, and changes are reported to `onChange`. No `vscode` import.
 * The send path (guard, queue, interrupt) lives in sendPath.ts.
 */
import type { ApprovalModeId, SearchMode } from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import { CHAT_S_TYPES, expireRequest, handleInbound, throttledResync } from "./inbound";
import { createRequestTracker, createRunTracker, type PendingRequest } from "./pending";
import { createSendPath } from "./sendPath";
import { createExtraRequests } from "./requests";
import { createCheckpointRequests } from "./checkpointRequests";
import type { ChatController, ChatControllerOptions, ChatErrorCode, ChatSnapshot, ServerInfo } from "./controllerTypes";
import { createState, currentItems, type ChatState } from "./state";
import { chatSupport, type ChatSupport } from "./support";

export type {
  ChatController,
  ChatControllerOptions,
  ChatError,
  ChatErrorCode,
  ChatSnapshot,
  ListState,
  ServerInfo,
} from "./controllerTypes";
export { MAX_QUEUE } from "./sendPath";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_START_TIMEOUT_MS = 30_000;
/** Quiet time before the context meter is refreshed after a draft change. */
const CONTEXT_DEBOUNCE_MS = 800;

export function createChatController(opts: ChatControllerOptions): ChatController {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const st: ChatState = createState();
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  const nextId = (prefix: string): string => `${prefix}${++st.seq}`;
  const emit = (): void => opts.onChange();
  const support = (): ChatSupport => chatSupport(st.serverInfo);
  const effectiveModel = (): string | null => st.model ?? st.defaultModel ?? st.models[0]?.ref ?? null;
  const currentCwd = (): string | null => {
    const roots = opts.roots();
    if (st.cwd !== null && roots.includes(st.cwd)) return st.cwd;
    return roots[0] ?? null;
  };
  const fail = (code: ChatErrorCode, message?: string): void => {
    st.error = { code, ...(message ? { message } : {}) };
    emit();
  };

  const pending = createRequestTracker((requestId: string, request: PendingRequest) => expireRequest(st, requestId, request, emit));
  const runs = createRunTracker(opts.runStartTimeoutMs ?? DEFAULT_RUN_START_TIMEOUT_MS, () => {
    st.error = { code: "timeout" };
    emit();
  });
  const sendPath = createSendPath({
    st,
    send: opts.send,
    clock: opts.now ?? Date.now,
    emit,
    fail,
    nextId,
    currentCwd,
    effectiveModel,
    support,
    pending,
    runs,
    promptAckTimeoutMs: opts.promptAckTimeoutMs ?? DEFAULT_PROMPT_ACK_TIMEOUT_MS,
  });

  /** Clears everything in flight (the connection went away, or the view was disposed). */
  const resetInFlight = (): void => {
    pending.clear();
    runs.stop();
    st.awaitingAck = null;
    st.loadingConversation = false;
  };

  const requestModels = (): void => {
    pending.drop((r) => r.kind === "models");
    const requestId = nextId("m");
    if (!opts.send({ type: "models_request", requestId })) return;
    pending.track(requestId, { kind: "models" }, timeoutMs);
    st.modelsState = "loading";
  };

  const requestConversations = (dir: string): void => {
    pending.drop((r) => r.kind === "conversations");
    const requestId = nextId("l");
    if (!opts.send({ type: "conversations_request", requestId, cwd: dir })) return;
    pending.track(requestId, { kind: "conversations" }, timeoutMs);
    st.conversationsState = "loading";
  };

  const requestLists = (): void => {
    if (support() === "unsupported") return;
    requestModels();
    const dir = currentCwd();
    if (dir !== null) requestConversations(dir);
  };

  const requestConversation = (id: string): boolean => {
    pending.drop((r) => r.kind === "conversation" && r.conversationId === id);
    const requestId = nextId("v");
    if (!opts.send({ type: "conversation_request", requestId, conversationId: id })) return false;
    pending.track(requestId, { kind: "conversation", conversationId: id }, timeoutMs);
    return true;
  };

  const extras = createExtraRequests({ st, send: opts.send, pending, nextId, timeoutMs, support, emit });
  const checkpoints = createCheckpointRequests({ st, send: opts.send, pending, nextId, timeoutMs, support, emit });
  const requestContext = (): void => extras.context();

  const refreshConversations = (): void => {
    const dir = currentCwd();
    if (dir !== null) requestConversations(dir);
  };

  const resync = throttledResync(requestConversation, opts.now ?? Date.now);
  const inboundDeps = { pending, runs, refreshConversations, resync, ensureSettings: extras.settings.ensureSettings };

  return {
    handleFrame(frame: Frame) {
      if (!CHAT_S_TYPES.has(frame.type)) return false;
      const wasRunning = runs.active();
      const consumed = handleInbound(frame, st, inboundDeps);
      if (consumed) {
        if (wasRunning && !runs.active()) {
          requestContext(); // a finished run changes the usage
          sendPath.drain();
        } else if (frame.type === "models") {
          sendPath.drain();
        } else if (frame.type === "transcript" && frame.reset === true && frame.conversationId === st.conversationId) {
          requestContext(); // the open conversation was (re)loaded
        } else if (frame.type === "compacted") {
          requestContext(); // the usage changed
        }
        emit();
      }
      return consumed;
    },
    setOnline(next) {
      st.online = next;
      if (next) {
        requestLists();
        if (st.conversationId && support() !== "unsupported") requestConversation(st.conversationId);
      } else {
        resetInFlight();
        st.modelsState = "idle";
        st.conversationsState = "idle";
        st.devices = { state: "idle", items: [] };
      }
      emit();
    },
    setServerInfo(info: ServerInfo | null) {
      st.serverInfo = info;
      emit();
    },
    refresh() {
      if (!st.online) return;
      requestLists();
      if (st.conversationId && support() !== "unsupported") requestConversation(st.conversationId);
    },
    snapshot(): ChatSnapshot {
      const running = st.online && runs.active();
      const sending = st.awaitingAck !== null;
      return {
        online: st.online,
        cwd: currentCwd(),
        cwds: [...opts.roots()],
        models: st.models,
        model: st.model,
        defaultModel: st.defaultModel,
        effectiveModel: effectiveModel(),
        approvalMode: st.approvalMode,
        conversations: st.conversations,
        conversationId: st.conversationId,
        items: currentItems(st),
        busy: sending || running,
        sending,
        running,
        error: st.error,
        chatSupport: support(),
        serverVersion: st.serverInfo?.serverVersion ?? null,
        modelsState: st.modelsState,
        conversationsState: st.conversationsState,
        loadingConversation: st.loadingConversation,
        searchMode: st.searchMode,
        queue: st.queue.map((q) => ({ id: q.id, text: q.text })),
        context: st.context,
        devices: st.devices, ...extras.view(),
        checkpoints: st.checkpoints,
      };
    },
    sendPrompt: sendPath.sendPrompt,
    checkpoints,
    cancelQueued(id: string) {
      st.queue = st.queue.filter((q) => q.id !== id);
      emit();
    },
    setSearchMode(mode: SearchMode | null) {
      st.searchMode = mode;
      emit();
    },
    draftChanged() {
      if (draftTimer !== null) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        draftTimer = null;
        requestContext();
      }, CONTEXT_DEBOUNCE_MS);
    },
    stop() {
      if (st.conversationId && support() !== "unsupported") {
        opts.send({ type: "stop", requestId: nextId("s"), conversationId: st.conversationId });
      }
    },
    newConversation() {
      st.conversationId = null;
      if (st.awaitingAck !== null) pending.untrack(st.awaitingAck);
      st.awaitingAck = null;
      st.loadingConversation = false;
      st.context = null;
      st.error = null;
      emit();
    },
    openConversation(id: string) {
      st.conversationId = id;
      st.error = null;
      st.context = null;
      const known = st.conversations.find((c) => c.id === id);
      if (known) {
        st.approvalMode = known.approvalMode;
        st.searchMode = known.searchMode ?? null;
      }
      if (support() === "unsupported") {
        fail("unsupported");
        return;
      }
      if (!requestConversation(id)) {
        fail("not_ready"); // offline: nothing would answer
        return;
      }
      st.loadingConversation = true;
      emit();
    },
    setModel(ref: string | null) {
      st.model = ref === null || st.models.some((m) => m.ref === ref) ? ref : st.model;
      emit();
    },
    setApprovalMode(mode: ApprovalModeId, confirmFull?: boolean) {
      if (mode === "full") {
        if (confirmFull !== true) return fail("confirm_required");
        st.fullConfirmed = true;
      }
      if (st.conversationId === null || support() === "unsupported") {
        st.approvalMode = mode; // sent with the first prompt
        st.error = null;
        emit();
        return;
      }
      const sent = opts.send({
        type: "set_approval_mode",
        requestId: nextId("a"),
        conversationId: st.conversationId,
        mode,
        ...(mode === "full" ? { confirmFull: true } : {}),
      });
      if (!sent) fail("not_ready");
    },
    setCwd(next: string) {
      if (!opts.roots().includes(next)) return;
      st.cwd = next;
      st.conversationId = null;
      st.loadingConversation = false;
      st.context = null;
      st.conversations = [];
      st.conversationsState = "idle";
      if (st.online) requestLists();
      emit();
    },
    clearError() {
      st.error = null;
      emit();
    },
    requestDevices: extras.devices, ...extras.settings,
    compact: extras.compact,
    refreshContext: (onUsage) => extras.context(onUsage),
    dispose() {
      if (draftTimer !== null) clearTimeout(draftTimer);
      draftTimer = null;
      resetInFlight();
    },
  };
}
