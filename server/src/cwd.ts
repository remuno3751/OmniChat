import { db, nextSeq, getConversationRow, toConversation } from "./db.js";
import type { Conversation } from "./db.js";

/* Working folders of Code conversations (docs/design/CODE-WORKSPACES.md). */

export const MAX_CWD = 1000;

/** Grouping key: `\` -> `/`, no trailing `/`, lower case for Windows-style paths. Same rule as the plugin's normCwd. */
export function normCwd(p: string): string {
  if (typeof p !== "string" || !p) return "";
  let r = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(r) || p.includes("\\")) r = r.toLowerCase();
  return r;
}

/**
 * Is `p` a well-formed absolute working folder? Absolute POSIX (`/x`), drive (`C:\x`, `C:/x`) or UNC (`\\host\x`) only;
 * no NUL / control characters, no `..` segment, at most MAX_CWD characters.
 */
export function isValidCwd(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_CWD) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (!(/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p))) return false;
  return !p.split(/[\\/]+/).includes("..");
}

/** Stores the working folder of a conversation if it changed. Returns the updated conversation (to broadcast) or null. */
export function setConversationCwd(conversationId: string, cwd: string): Conversation | null {
  if (!isValidCwd(cwd)) return null;
  const row = getConversationRow(conversationId);
  if (!row || row.deleted || row.cwd === cwd) return null;
  db.prepare("UPDATE conversations SET cwd = ?, seq = ? WHERE id = ?").run(cwd, nextSeq(), conversationId);
  return toConversation(getConversationRow(conversationId));
}
