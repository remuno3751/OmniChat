/**
 * Pure reducer for the chat transcript. Streaming re-sends an item with the same id and its full
 * new text, so an update replaces that item in place; `reset` replaces everything (the reply to a
 * conversation_request). No `vscode` import.
 */
import type { TranscriptFrame, TranscriptItem } from "../protocol/chat-frames";

/** Bound on the items kept per conversation; the oldest are dropped first. */
export const MAX_ITEMS = 600;

/** Applies one `transcript` frame and returns the new list. The input list is never mutated. */
export function applyTranscript(items: readonly TranscriptItem[], frame: TranscriptFrame): TranscriptItem[] {
  const next: TranscriptItem[] = frame.reset === true ? [] : [...items];
  for (const incoming of frame.items) {
    const id = incoming.id;
    const at = id === undefined ? -1 : next.findIndex((it) => it.id === id);
    if (at >= 0) next[at] = incoming;
    else next.push(incoming);
  }
  return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
}

/** True while the assistant is streaming or a tool is still pending/running. */
export function isRunning(items: readonly TranscriptItem[]): boolean {
  return items.some(
    (it) =>
      (it.kind === "assistant" && it.status === "streaming") ||
      (it.kind === "tool" && (it.status === "pending" || it.status === "running")),
  );
}

/** Counts tool items by status, for the activity strip. */
export function toolCounts(items: readonly TranscriptItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    if (it.kind === "tool") counts[it.status] = (counts[it.status] ?? 0) + 1;
  }
  return counts;
}

/** A tool row's one-line label: `edit_file  src/a.ts`. */
export function toolLabel(item: Extract<TranscriptItem, { kind: "tool" }>): string {
  return item.summary === "" ? item.tool : `${item.tool}  ${item.summary}`;
}
