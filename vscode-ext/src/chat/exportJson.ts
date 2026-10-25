/**
 * JSON export of a conversation for `/export json`: the user and assistant messages and the tool rows of the
 * transcript the host holds. No tokens, keys, working folder or device names, and no tool diffs. A timestamp is
 * kept only where the item has one. Pure, no `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";

export interface ExportedItem {
  kind: "user" | "assistant" | "tool";
  id: string;
  /** user and assistant items */
  text?: string;
  /** tool items */
  tool?: string;
  summary?: string;
  status?: string;
  /** ms epoch, only when the item carries one */
  at?: number;
}

export interface ConversationExport {
  title: string;
  conversationId: string;
  /** ISO 8601 time of the export */
  exportedAt: string;
  items: ExportedItem[];
}

/** The export as a plain object. Status rows (connection notes) are left out. */
export function conversationExport(
  title: string,
  conversationId: string,
  items: readonly TranscriptItem[],
  now: number,
): ConversationExport {
  const out: ExportedItem[] = [];
  for (const item of items) {
    const at = (item as { at?: unknown }).at;
    const stamp = typeof at === "number" ? { at } : {};
    if (item.kind === "user") {
      out.push({ kind: "user", id: item.id, text: item.text, ...stamp });
    } else if (item.kind === "assistant") {
      out.push({ kind: "assistant", id: item.id, text: item.text, status: item.status, ...stamp });
    } else if (item.kind === "tool") {
      out.push({ kind: "tool", id: item.id, tool: item.tool, summary: item.summary, status: item.status, ...stamp });
    }
  }
  return { title: title.trim(), conversationId, exportedAt: new Date(now).toISOString(), items: out };
}

/** The export as JSON text (2-space indent, trailing newline). */
export function conversationJson(
  title: string,
  conversationId: string,
  items: readonly TranscriptItem[],
  now: number,
): string {
  return `${JSON.stringify(conversationExport(title, conversationId, items, now), null, 2)}\n`;
}
