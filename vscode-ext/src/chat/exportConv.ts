/**
 * Markdown transcript of a conversation for `/export`: user and assistant text, one line per tool call, no
 * reasoning or status rows. Pure, no `vscode` import.
 */
import type { TranscriptItem } from "../protocol/chat-frames";

/** One line of text, with the whitespace runs collapsed. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function conversationMarkdown(title: string, items: readonly TranscriptItem[]): string {
  const blocks: string[] = [`# ${oneLine(title) || "Conversation"}`];
  for (const item of items) {
    if (item.kind === "user") {
      blocks.push(`## User\n\n${item.text.trim()}`);
    } else if (item.kind === "assistant") {
      const text = item.text.trim();
      if (text !== "") blocks.push(`## Assistant\n\n${text}`);
    } else if (item.kind === "tool") {
      blocks.push(`- Tool \`${oneLine(item.tool)}\`: ${oneLine(item.summary)}`);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}
