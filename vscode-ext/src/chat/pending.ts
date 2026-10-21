/**
 * Request bookkeeping for the chat controller. Each request frame is tracked by requestId with a
 * timer; the run tracker follows an acknowledged prompt until its transcript shows it finished.
 * Uses the global setTimeout/clearTimeout, so fake timers apply. No `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";
import { isRunning } from "./transcript";

export type PendingKind = "prompt" | "models" | "conversations" | "conversation";

export interface PendingRequest {
  kind: PendingKind;
  conversationId?: string;
}

export interface RequestTracker {
  track(requestId: string, request: PendingRequest, ms: number): void;
  /** Removes a request and clears its timer. Returns it, or undefined when unknown. */
  untrack(requestId: string): PendingRequest | undefined;
  /** Forgets every request that matches, without any callback (a newer request replaces it). */
  drop(match: (request: PendingRequest) => boolean): void;
  clear(): void;
}

/** `onExpire` runs when a request is still pending after its timeout. */
export function createRequestTracker(onExpire: (requestId: string, request: PendingRequest) => void): RequestTracker {
  const entries = new Map<string, { request: PendingRequest; timer: ReturnType<typeof setTimeout> }>();
  const untrack = (requestId: string): PendingRequest | undefined => {
    const entry = entries.get(requestId);
    if (entry === undefined) return undefined;
    clearTimeout(entry.timer);
    entries.delete(requestId);
    return entry.request;
  };
  return {
    track(requestId, request, ms) {
      const timer = setTimeout(() => {
        entries.delete(requestId);
        onExpire(requestId, request);
      }, ms);
      entries.set(requestId, { request, timer });
    },
    untrack,
    drop(match) {
      for (const [requestId, entry] of entries) if (match(entry.request)) untrack(requestId);
    },
    clear() {
      for (const requestId of [...entries.keys()]) untrack(requestId);
    },
  };
}

export interface RunTracker {
  /** A prompt was acknowledged on `conversationId`; `baseline` is the transcript length before it. */
  start(conversationId: string, baseline: number): void;
  /** True from the ack until the run's transcript shows it finished. */
  active(): boolean;
  /** Ends the run without an error (offline, disposed). */
  stop(): void;
  /** Feeds the transcript of a conversation. Only the run's own conversation counts. */
  observe(conversationId: string, items: readonly TranscriptItem[]): void;
}

/** `onExpire` runs when no transcript for the run arrives within `ms`. */
export function createRunTracker(ms: number, onExpire: () => void): RunTracker {
  let acked = false;
  let conversation: string | null = null;
  let baseline = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    start(conversationId, base) {
      acked = true;
      conversation = conversationId;
      baseline = base;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (!acked) return;
        acked = false;
        onExpire();
      }, ms);
    },
    active: () => acked,
    stop() {
      acked = false;
      clearTimer();
    },
    observe(conversationId, items) {
      if (!acked || conversationId !== conversation) return;
      clearTimer();
      // Finished: nothing is running and the reply (or a status line) came after the ack.
      const finished = !isRunning(items) && items.slice(baseline).some((it) => it.kind === "assistant" || it.kind === "status");
      if (finished) acked = false;
    },
  };
}
