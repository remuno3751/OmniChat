/**
 * The send path of the chat controller: the send guard, the double-click guard, the prompt queue
 * (max 10, sent in order when the active run ends) and the interrupt send. Split from controller.ts
 * to keep both under the size limit. No `vscode` import.
 */
import type { PromptAttachment, SearchMode } from "../protocol/chat-frames";
import type { Frame } from "../protocol/frames";
import type { ChatErrorCode } from "./controllerTypes";
import type { RequestTracker, RunTracker } from "./pending";
import { cutFromLastUser } from "./editLast";
import type { ChatState, QueuedPrompt } from "./state";
import type { ChatSupport } from "./support";

/** Same text sent again within this window is a double click. */
const DOUBLE_CLICK_MS = 300;
/** Most prompts that may wait behind an active run. */
export const MAX_QUEUE = 10;

export interface SendPathDeps {
  st: ChatState;
  send: (frame: Frame) => boolean;
  clock: () => number;
  emit: () => void;
  fail: (code: ChatErrorCode, message?: string) => void;
  nextId: (prefix: string) => string;
  currentCwd: () => string | null;
  effectiveModel: () => string | null;
  support: () => ChatSupport;
  pending: RequestTracker;
  runs: RunTracker;
  promptAckTimeoutMs: number;
}

export interface SendPath {
  /** See ChatController.sendPrompt. */
  sendPrompt(text: string, o?: { interrupt?: boolean; attachments?: PromptAttachment[]; replaceLast?: boolean }): boolean;
  /** Sends the oldest queued prompt when nothing is in flight; it stays queued if the send fails. */
  drain(): void;
}

export function createSendPath(d: SendPathDeps): SendPath {
  const { st } = d;
  let lastSubmitAt = -Infinity;
  let lastSubmitText = "";

  /**
   * Sends one prompt now. Returns false (after setting the error) when it cannot be sent.
   * `conversationId` null starts a new conversation. `replaceLast` cuts the open transcript from its last
   * user message once the prompt is sent (the server does the same; the next transcript frame replaces it).
   */
  const dispatch = (
    text: string,
    conversationId: string | null,
    interrupt: boolean,
    attachments: PromptAttachment[],
    replaceLast = false,
  ): boolean => {
    const dir = d.currentCwd();
    if (!st.online || dir === null) {
      d.fail("not_ready");
      return false;
    }
    const modelRef = d.effectiveModel();
    if (modelRef === null) {
      d.fail(st.modelsState === "ready" && st.models.length === 0 ? "no_models" : "no_model");
      return false;
    }
    const requestId = d.nextId("p");
    const searchMode: SearchMode | null = st.searchMode;
    const sent = d.send({
      type: "prompt",
      requestId,
      cwd: dir,
      text,
      ...(conversationId ? { conversationId } : {}),
      model: modelRef,
      approvalMode: st.approvalMode,
      ...(st.approvalMode === "full" && st.fullConfirmed ? { confirmFull: true } : {}),
      ...(searchMode !== null ? { searchMode } : {}),
      ...(interrupt ? { interrupt: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replaceLast ? { replaceLast: true as const } : {}),
    });
    if (!sent) {
      d.fail("send_failed");
      return false;
    }
    if (replaceLast && conversationId !== null) st.transcripts.set(conversationId, cutFromLastUser(st.transcripts.get(conversationId) ?? []));
    d.pending.track(requestId, { kind: "prompt" }, d.promptAckTimeoutMs);
    st.awaitingAck = requestId;
    st.error = null;
    lastSubmitAt = d.clock();
    d.emit();
    return true;
  };

  const drain = (): void => {
    if (!st.online || st.awaitingAck !== null || d.runs.active()) return;
    const next: QueuedPrompt | undefined = st.queue.shift();
    if (next === undefined) return;
    if (!dispatch(next.text, next.conversationId ?? st.conversationId, false, next.attachments)) st.queue.unshift(next);
  };

  const sendPrompt = (text: string, o?: { interrupt?: boolean; attachments?: PromptAttachment[]; replaceLast?: boolean }): boolean => {
    const body = text.trim();
    const attachments = o?.attachments ?? [];
    const replaceLast = o?.replaceLast === true;
    if (body === "") {
      d.emit();
      return false;
    }
    // A double click sends the same text again at once: take it only once.
    if (body === lastSubmitText && d.clock() - lastSubmitAt < DOUBLE_CLICK_MS) {
      d.emit();
      return false;
    }
    if (!st.online) {
      d.fail("not_ready");
      return false;
    }
    if (d.support() === "unsupported") {
      d.fail("unsupported");
      return false;
    }
    const interrupt = o?.interrupt === true;
    const waiting = st.awaitingAck !== null || d.runs.active();
    // An edit of the last prompt is never queued: while a run is active it is refused (the host toasts it).
    if (replaceLast && waiting) return false;
    let accepted: boolean;
    if (!waiting || (interrupt && st.awaitingAck === null)) {
      accepted = dispatch(body, st.conversationId, interrupt, attachments, replaceLast);
    } else {
      if (st.queue.length >= MAX_QUEUE) {
        d.fail("busy");
        return false;
      }
      const item: QueuedPrompt = { id: d.nextId("q"), text: body, conversationId: st.conversationId, attachments };
      if (interrupt) st.queue.unshift(item);
      else st.queue.push(item);
      accepted = true;
      d.emit();
    }
    if (accepted) {
      lastSubmitText = body;
      lastSubmitAt = d.clock();
    }
    return accepted;
  };

  return { sendPrompt, drain };
}
