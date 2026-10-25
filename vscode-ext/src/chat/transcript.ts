/**
 * Pure reducer for the chat transcript. Streaming re-sends an item with the same id and its full
 * new text, so an update replaces that item in place; `reset` replaces everything (the reply to a
 * conversation_request). No `vscode` import.
 */
import type { TranscriptFrame, TranscriptItem } from "../protocol/chat-frames";

/** Bound on the items kept per conversation; the oldest are dropped first. */
export const MAX_ITEMS = 600;

/** Result of applying a transcript frame: the new list, and whether a delta could not be applied. */
export interface CheckedTranscript {
  items: TranscriptItem[];
  /** A delta did not match the stored item (or the item is unknown). That item was kept unchanged. */
  stale: boolean;
}

/** Applies one `transcript` frame and returns the new list. The input list is never mutated. */
export function applyTranscript(items: readonly TranscriptItem[], frame: TranscriptFrame): TranscriptItem[] {
  return applyTranscriptChecked(items, frame).items;
}

/**
 * Like applyTranscript, and also reports stale deltas. A delta assistant item (`from` or
 * `reasoningFrom` set) appends its suffix only when the stored text has exactly that length; otherwise
 * the stored item stays as it is and `stale` is set, so the caller can ask for a full transcript.
 */
export function applyTranscriptChecked(items: readonly TranscriptItem[], frame: TranscriptFrame): CheckedTranscript {
  const next: TranscriptItem[] = frame.reset === true ? [] : [...items];
  let stale = false;
  for (const incoming of frame.items) {
    const id = incoming.id;
    const at = id === undefined ? -1 : next.findIndex((it) => it.id === id);
    if (incoming.kind === "assistant" && (incoming.from !== undefined || incoming.reasoningFrom !== undefined)) {
      const current = at >= 0 ? next[at] : undefined;
      const merged = current?.kind === "assistant" ? mergeDelta(current, incoming) : null;
      if (merged === null) stale = true;
      else next[at] = merged;
    } else if (at >= 0) {
      next[at] = incoming;
    } else {
      next.push(incoming);
    }
  }
  return { items: next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next, stale };
}

type Assistant = Extract<TranscriptItem, { kind: "assistant" }>;

/** The assistant item after a delta, or null when the delta does not start where the stored text ends. */
function mergeDelta(current: Assistant, delta: Assistant): Assistant | null {
  let text = delta.text;
  if (delta.from !== undefined) {
    if (current.text.length !== delta.from) return null;
    text = current.text + delta.text;
  }
  let reasoning = delta.reasoning ?? current.reasoning;
  if (delta.reasoningFrom !== undefined) {
    const have = current.reasoning ?? "";
    if (have.length !== delta.reasoningFrom) return null;
    reasoning = have + (delta.reasoning ?? "");
  }
  // Built fresh so the stored item never keeps `from` / `reasoningFrom`.
  return {
    kind: "assistant",
    id: delta.id,
    text,
    status: delta.status,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
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
