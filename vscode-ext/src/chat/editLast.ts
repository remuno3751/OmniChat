/**
 * Local side of "edit the last prompt" (v0.5.6-E): the transcript without the last user message and
 * everything after it. The server removes the same items; the next `transcript` frame replaces this list.
 * Pure: no `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";

export function cutFromLastUser(items: readonly TranscriptItem[]): TranscriptItem[] {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "user") {
      at = i;
      break;
    }
  }
  return at < 0 ? [...items] : items.slice(0, at);
}
