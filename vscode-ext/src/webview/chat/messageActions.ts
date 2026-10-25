/**
 * Pure helpers behind the beta.2 message and queue actions (no DOM here, so they are unit-tested in node).
 * Messages the host does not list in ChatMessage yet are sent through `sendAction` (see the contract, beta.2 follow-up).
 */
import type { ChatMessage, Send } from "./types";

/** Webview -> host messages of beta.2 that ChatMessage does not list yet (`interruptQueued`, `regenerate`). */
export type ActionMessage = { type: "interruptQueued"; id: string } | { type: "regenerate"; id: string };

/** Sends a beta.2 action; the host validates it (until ChatMessage lists these types). */
export function sendAction(send: Send, msg: ActionMessage): void {
  send(msg as unknown as ChatMessage);
}

/**
 * The composer text after a queued prompt is taken back into it: the text alone when the composer is empty,
 * otherwise the existing text, a newline, and the prompt.
 */
export function appendDraft(existing: string, text: string): string {
  if (existing.trim() === "") return text;
  return `${existing}\n${text}`;
}

/** The fields of a transcript item that the action rules look at. */
export interface ActionItem {
  id?: string;
  kind: string;
  status?: string;
}

/** The last assistant item of the transcript, or null. */
export function lastAssistant(items: readonly ActionItem[]): ActionItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "assistant") return items[i];
  }
  return null;
}

const FINISHED = new Set(["done", "error", "stopped"]);

/**
 * Regenerate is offered only on the last assistant message, once it is finished (done, error or stopped),
 * and never while a run is active or a prompt is being sent.
 */
export function canRegenerate(items: readonly ActionItem[], itemId: string, busy: boolean): boolean {
  if (busy) return false;
  const last = lastAssistant(items);
  if (!last || last.id !== itemId) return false;
  return FINISHED.has(last.status ?? "");
}
