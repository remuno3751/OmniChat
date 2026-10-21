/* Live transcript of a Code run for the VS Code chat panel (docs/design/VSCODE-BRIDGE.md S12).
   A TranscriptFeed belongs to one running turn (code-agent.ts creates it); it collects the user message, the tool calls and the
   streaming answer and sends `transcript` frames to every chat-capable instance of the bridge, at most 10 frames/s. Streaming
   updates re-send the same item id with the full new text. `historyItems` builds the full history for `conversation_request`. */
import { db, getMessageRow } from "./db.js";
import type { ToolCall } from "./tools/types.js";
import { sendToChatInstances } from "./vscode-bridge.js";
import { callSummary } from "./code-tools.js";

export type TranscriptStatus = "streaming" | "done" | "error" | "stopped";
export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning?: string; status: TranscriptStatus }
  | { kind: "tool"; id: string; tool: string; summary: string; status: ToolCall["status"]; decidedBy?: string; durationMs?: number }
  | { kind: "status"; id?: string; text: string };

/** Minimum gap between two frames of one conversation (10 frames/s). */
export const TRANSCRIPT_INTERVAL_MS = 100;
const MAX_TEXT = 400_000;
const MAX_HISTORY_MESSAGES = 100;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function toolItem(messageId: string, call: Pick<ToolCall, "id" | "name" | "arguments" | "status" | "decidedBy" | "durationMs">): TranscriptItem {
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
  const status = (["pending", "running", "done", "error", "denied"] as const).includes(call.status) ? call.status : "error";
  return {
    kind: "tool", id: `${messageId}:${call.id}`, tool: String(call.name).slice(0, 60), summary: callSummary(String(call.name), args), status,
    ...(call.decidedBy ? { decidedBy: String(call.decidedBy).slice(0, 100) } : {}),
    ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) ? { durationMs: Math.round(call.durationMs) } : {}),
  };
}

const feeds = new Map<string, TranscriptFeed>();
/** The feed of the run that is active in this conversation, if any. */
export const activeFeed = (conversationId: string): TranscriptFeed | undefined => feeds.get(conversationId);

export interface FeedOptions { userId: string; bridge: string; conversationId: string; userMessageId: string | null; assistantMessageId: string }

export class TranscriptFeed {
  runId: string | undefined;
  private text = "";
  private reasoning = "";
  private status: TranscriptStatus = "streaming";
  private statusNote: string | null = null;
  private readonly user: TranscriptItem | null;
  private readonly tools = new Map<string, TranscriptItem>();
  private dirty = new Set<string>();
  private lastSent = 0;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private readonly aid: string;

  constructor(private readonly o: FeedOptions) {
    this.aid = o.assistantMessageId;
    const u = o.userMessageId ? getMessageRow(o.userMessageId) : undefined;
    this.user = u ? { kind: "user", id: u.id, text: clip(String(u.content ?? ""), MAX_TEXT) } : null;
    feeds.set(o.conversationId, this);
    this.mark(this.user ? this.user.id! : "", this.aid);
  }

  setRunId(id: string): void { this.runId = id; }
  addText(t: string): void { if (!t || this.ended) return; this.text = clip(this.text + t, MAX_TEXT); this.mark(this.aid); }
  addReasoning(t: string): void { if (!t || this.ended) return; this.reasoning = clip(this.reasoning + t, MAX_TEXT); this.mark(this.aid); }
  tool(call: ToolCall): void {
    if (this.ended) return;
    const it = toolItem(this.aid, call);
    this.tools.set((it as { id: string }).id, it);
    this.mark((it as { id: string }).id);
  }
  /** Marks the run finished (final frame goes out within the throttle interval). `note` = an error text shown as a status item. */
  end(status: Exclude<TranscriptStatus, "streaming">, note?: string): void {
    if (this.ended) return;
    this.status = status;
    if (note) this.statusNote = clip(note, 2000);
    this.ended = true;
    this.mark(this.aid, this.statusNote ? `${this.aid}:status` : "");
  }

  /** Current items in display order: user, tools, answer, status. */
  snapshot(): TranscriptItem[] {
    const out: TranscriptItem[] = [];
    if (this.user) out.push(this.user);
    out.push(...this.tools.values());
    out.push(this.assistantItem());
    if (this.statusNote) out.push({ kind: "status", id: `${this.aid}:status`, text: this.statusNote });
    return out;
  }

  private assistantItem(): TranscriptItem {
    return { kind: "assistant", id: this.aid, text: this.text, ...(this.reasoning ? { reasoning: this.reasoning } : {}), status: this.status };
  }

  private mark(...ids: string[]): void {
    for (const id of ids) if (id) this.dirty.add(id);
    if (this.timer) return;
    const wait = Math.max(0, TRANSCRIPT_INTERVAL_MS - (Date.now() - this.lastSent));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    const ids = this.dirty;
    this.dirty = new Set();
    const items = this.snapshot().filter((it) => ids.has((it as { id?: string }).id ?? ""));
    if (items.length) {
      this.lastSent = Date.now();
      sendToChatInstances(this.o.userId, this.o.bridge, { type: "transcript", conversationId: this.o.conversationId, ...(this.runId ? { runId: this.runId } : {}), items });
    }
    if (this.ended && this.dirty.size === 0 && feeds.get(this.o.conversationId) === this) feeds.delete(this.o.conversationId);
  }
}

export function beginTranscript(o: FeedOptions): TranscriptFeed { return new TranscriptFeed(o); }

/* ---------- history (conversation_request) ---------- */

const statusOf = (s: unknown): TranscriptStatus => (s === "done" || s === "error" || s === "stopped" ? s : "streaming");

/** Full history of a conversation: messages in order, tool calls before the answer of their message. A running turn's live state wins. */
export function historyItems(conversationId: string): TranscriptItem[] {
  const rows = (db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?").all(conversationId, MAX_HISTORY_MESSAGES) as any[]).reverse();
  const live = feeds.get(conversationId)?.snapshot() ?? [];
  const liveIds = new Set(live.map((i) => (i as { id?: string }).id));
  const items: TranscriptItem[] = [];
  for (const r of rows) {
    if (r.role === "user") { items.push({ kind: "user", id: r.id, text: clip(String(r.content ?? ""), MAX_TEXT) }); continue; }
    if (r.role !== "assistant") continue;
    let calls: ToolCall[] = [];
    try { const a = r.tool_calls ? JSON.parse(r.tool_calls) : null; if (Array.isArray(a)) calls = a; } catch { /* no trace */ }
    for (const c of calls) if (c && typeof c.id === "string" && typeof c.name === "string") items.push(toolItem(r.id, c));
    if (liveIds.has(r.id)) continue; // replaced by the live snapshot below
    items.push({
      kind: "assistant", id: r.id, text: clip(String(r.content ?? ""), MAX_TEXT),
      ...(typeof r.reasoning === "string" && r.reasoning ? { reasoning: clip(r.reasoning, MAX_TEXT) } : {}), status: statusOf(r.status),
    });
  }
  // live state: replace by id (tool items) or append (answer of the running turn)
  if (live.length) {
    const byId = new Map(items.map((it, i) => [(it as { id?: string }).id, i] as const));
    for (const it of live) {
      const i = byId.get((it as { id?: string }).id);
      if (i !== undefined) items[i] = it; else items.push(it);
    }
  }
  return items;
}
