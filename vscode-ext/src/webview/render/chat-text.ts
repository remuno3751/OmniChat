/*
 * Plain-text rendering for user messages (no Markdown). Pure, no DOM, no vscode import.
 */
import { escapeHtml } from "./markdown";

/** Escapes the text and turns line breaks into <br>. Never interprets Markdown or HTML. */
export function plainToHtml(text: string): string {
  return escapeHtml(String(text ?? "").replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}
