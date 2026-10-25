/* Chat settings from inside VS Code (docs/design/V056D-CONTRACT.md, v0.5.6-d): conversation_settings_request / _set (this chat's
   system prompt, system mode, effort and title) and history_search_request (the user's history, only the Code chats of this bridge).
   Dispatched from vscode-chat.ts. Same columns and validation as the app's PUT /conversations/:id (routes-chat.ts). */
import { db, nextSeq, toConversation, getConversationRow, type Effort } from "./db.js";
import { broadcast } from "./hub.js";
import { sanitizeEffort } from "./sampling.js";
import { searchHistory, type HistoryHit } from "./history-search.js";
import { ownConversation } from "./vscode-chat-extra.js";
import type { RawFrame, VscodeChatPeer } from "./vscode-bridge.js";

const MAX_SYSTEM_PROMPT = 20000;
const MAX_TITLE = 200;
const MAX_QUERY = 200;
const MAX_SEARCH_RESULTS = 30;
const SEARCH_PAGES = 4; // the first page and up to 3 more, when the filter drops hits of other chats

const idOf = (v: unknown): string | null => (typeof v === "string" && v.length >= 1 && v.length <= 100 ? v : null);
function errorFrame(peer: VscodeChatPeer, code: string, message: string, requestId?: string | null): void {
  peer.reply({ type: "error", code, message, ...(requestId ? { requestId } : {}) });
}

interface Settings { systemPrompt: string; systemMode: "append" | "replace"; effort: Effort | null }
const settingsOf = (row: any): Settings => {
  const c = toConversation(row);
  return { systemPrompt: c.systemPrompt ?? "", systemMode: c.systemMode, effort: c.effort };
};

/** conversation_settings_request -> conversation_settings, or an error frame (not_found for other chats). */
export function onConversationSettings(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "conversation_settings_request needs requestId and conversationId", requestId); return; }
  const row = ownConversation(peer.userId, peer.bridge, id);
  if (!row) { errorFrame(peer, "not_found", "Conversation not found", requestId); return; }
  peer.reply({ type: "conversation_settings", requestId, conversationId: id, ...settingsOf(row), title: toConversation(row).title });
}

type Patch = { systemPrompt?: string | null; systemMode?: "append" | "replace"; effort?: Effort | null; title?: string };

/** The fields present in the frame, validated like routes-chat.ts; an error message when one is invalid. */
function patchOf(m: RawFrame): { patch: Patch } | { error: string } {
  const patch: Patch = {};
  if (m.systemPrompt !== undefined) {
    if (typeof m.systemPrompt !== "string" || m.systemPrompt.length > MAX_SYSTEM_PROMPT) return { error: `systemPrompt must be a string of up to ${MAX_SYSTEM_PROMPT} characters` };
    patch.systemPrompt = m.systemPrompt === "" ? null : m.systemPrompt;
  }
  if (m.systemMode !== undefined) {
    if (m.systemMode !== "append" && m.systemMode !== "replace") return { error: "systemMode must be append or replace" };
    patch.systemMode = m.systemMode;
  }
  if (m.effort !== undefined) {
    const e = sanitizeEffort(m.effort);
    if (e === undefined) return { error: "effort must be off, low, medium, high, max or null" };
    patch.effort = e;
  }
  if (m.title !== undefined) {
    const t = typeof m.title === "string" ? m.title.trim() : "";
    if (!t || t.length > MAX_TITLE) return { error: `title must be 1 to ${MAX_TITLE} characters` };
    patch.title = t;
  }
  return { patch };
}

/** conversation_settings_set -> conversation_settings_ack. Allowed while a run is active (settings may change during a run). */
export function onConversationSettingsSet(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  const id = idOf(m.conversationId);
  if (!requestId || !id) { errorFrame(peer, "invalid_frame", "conversation_settings_set needs requestId and conversationId", requestId); return; }
  const reply = (ok: boolean, extra: Record<string, unknown> = {}): void => { peer.reply({ type: "conversation_settings_ack", requestId, conversationId: id, ok, ...extra }); };
  const parsed = patchOf(m);
  if ("error" in parsed) { reply(false, { error: "invalid_frame", message: parsed.error }); return; }
  const row = ownConversation(peer.userId, peer.bridge, id);
  if (!row) { reply(false, { error: "not_found", message: "Conversation not found" }); return; }

  const p = parsed.patch;
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (p.systemPrompt !== undefined) { sets.push("system_prompt = ?"); args.push(p.systemPrompt); }
  if (p.systemMode !== undefined) { sets.push("system_mode = ?"); args.push(p.systemMode); }
  if (p.effort !== undefined) { sets.push("effort = ?"); args.push(p.effort); }
  if (p.title !== undefined) { sets.push("title = ?"); args.push(p.title); }
  if (sets.length) {
    db.prepare(`UPDATE conversations SET ${sets.join(", ")}, seq = ? WHERE id = ?`).run(...args, nextSeq(), id);
    broadcast(peer.userId, { type: "upsert", conversations: [toConversation(getConversationRow(id))] });
  }
  const fresh = getConversationRow(id);
  reply(true, { settings: settingsOf(fresh), title: toConversation(fresh).title });
}

const hitOf = (h: HistoryHit) => ({
  conversationId: h.conversationId, title: h.conversationTitle, snippet: h.snippet, at: h.createdAt,
  ...(h.messageId ? { messageId: h.messageId } : {}), ...(h.role ? { role: h.role } : {}),
});

/** history_search_request -> history_search: hits of this bridge's Code chats only, up to `limit` (<= 30). */
export function onHistorySearch(peer: VscodeChatPeer, m: RawFrame): void {
  const requestId = idOf(m.requestId);
  if (!requestId) { errorFrame(peer, "invalid_frame", "history_search_request needs a requestId"); return; }
  const query = typeof m.query === "string" ? m.query.trim() : "";
  if (!query || query.length > MAX_QUERY) { errorFrame(peer, "invalid_frame", `query must be 1 to ${MAX_QUERY} characters`, requestId); return; }
  if (m.limit !== undefined && !(Number.isInteger(m.limit) && m.limit > 0)) { errorFrame(peer, "invalid_frame", "limit must be a positive integer", requestId); return; }
  const want = Math.min(MAX_SEARCH_RESULTS, m.limit ?? MAX_SEARCH_RESULTS);

  const results: ReturnType<typeof hitOf>[] = [];
  for (let page = 0, offset = 0; page < SEARCH_PAGES && results.length < want; page++, offset += MAX_SEARCH_RESULTS) {
    const r = searchHistory(peer.userId, query, { limit: MAX_SEARCH_RESULTS, offset });
    for (const h of r.results) {
      if (results.length >= want) break;
      if (ownConversation(peer.userId, peer.bridge, h.conversationId)) results.push(hitOf(h));
    }
    if (r.results.length < MAX_SEARCH_RESULTS) break; // no more hits in the history
  }
  peer.reply({ type: "history_search", requestId, query, results });
}
