/**
 * Host side of the queue chip ("run now") and the assistant item's "regenerate" button. Pure: they act
 * through a controller handle and report the outcome; the caller decides what to toast. No `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";
import type { ChatController } from "./controllerTypes";

/** The controller calls the actions need. */
export type ActionController = Pick<ChatController, "snapshot" | "cancelQueued" | "sendPrompt">;

/**
 * Runs a queued prompt now: sends its text with interrupt (as Ctrl+Enter does), then removes the entry.
 * The send comes first, so a refused send (offline, a duplicate, a full queue) leaves the entry queued.
 * False when there is no such entry or the send was refused.
 */
export function interruptQueued(c: ActionController, id: string): boolean {
  const entry = c.snapshot().queue.find((q) => q.id === id);
  if (!entry) return false;
  if (!c.sendPrompt(entry.text, { interrupt: true })) return false;
  c.cancelQueued(id);
  return true;
}

export type RegenerateResult = "sent" | "busy" | "missing" | "refused";

/** The text of the nearest user item before `index`, or null. */
export function precedingUserText(items: readonly TranscriptItem[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user") return item.text;
  }
  return null;
}

/**
 * Sends again the user message that produced the assistant item `id`, with the current model and
 * settings, as a normal prompt. Refused ("busy") while a run is active or a prompt is in flight.
 */
export function regenerateItem(c: ActionController, id: string): RegenerateResult {
  const snap = c.snapshot();
  if (snap.busy) return "busy";
  const index = snap.items.findIndex((it) => it.kind === "assistant" && it.id === id);
  if (index < 0) return "missing";
  const text = precedingUserText(snap.items, index);
  if (text === null) return "missing";
  return c.sendPrompt(text) ? "sent" : "refused";
}
