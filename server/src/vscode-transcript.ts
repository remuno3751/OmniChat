/* Live transcript of a Code run for the VS Code chat panel (docs/design/VSCODE-BRIDGE.md S12).
   A TranscriptFeed belongs to one running turn (code-agent.ts creates it); it collects the user message, the tool calls and the
   streaming answer and sends `transcript` frames to every chat-capable instance of the bridge, at most 10 frames/s. Streaming
   updates re-send the same item id with the full new text. `historyItems` builds the full history for `conversation_request`. */
import { db, getMessageRow } from "./db.js";
import type { ToolCall } from "./tools/types.js";
import { sendToChatInstancesBy } from "./vscode-bridge.js";
import { callSummary } from "./code-tools.js";

export type TranscriptStatus = "streaming" | "done" | "error" | "stopped";
/** Code diff of an edit_file / write_file call (contract v0.5.5-a). `lines[i]` starts with `+`, `-` or a space. */
export interface TranscriptDiff { path: string; added: number; removed: number; truncated?: boolean; lines: string[] }
/** A web source of an answer (contract v0.5.6-E §1). No snippet: only what the chat panel shows. */
export interface TranscriptSource { title: string; url: string; host: string }
export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  /* from / reasoningFrom: a delta frame (instances with transcriptDelta, while streaming): text / reasoning are only the suffix after that length */
  | { kind: "assistant"; id: string; text: string; from?: number; reasoning?: string; reasoningFrom?: number; status: TranscriptStatus; sources?: TranscriptSource[] }
  | { kind: "tool"; id: string; tool: string; summary: string; status: ToolCall["status"]; decidedBy?: string; durationMs?: number; diff?: TranscriptDiff }
  | { kind: "status"; id?: string; text: string };

/** Minimum gap between two frames of one conversation (10 frames/s). */
export const TRANSCRIPT_INTERVAL_MS = 100;
const MAX_TEXT = 400_000;
const MAX_HISTORY_MESSAGES = 100;
const DIFF_MAX_LINES = 200;
const DIFF_LINE_MAX = 300;
const DIFF_PATH_MAX = 300;
const DIFF_CONTEXT = 2;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const SOURCES_MAX = 8;
const SOURCE_TITLE_MAX = 200;
const SOURCE_URL_MAX = 500;

/** Sources of an answer for the chat panel (contract v0.5.6-E §1). Accepts the stored / live `{index,title,url,snippet?}` list.
    http/https only; user info and fragment removed; host = hostname; at most 8; a bad entry is dropped on its own. Pure. */
export function toTranscriptSources(list: unknown): TranscriptSource[] {
  if (!Array.isArray(list)) return [];
  const out: TranscriptSource[] = [];
  for (const s of list) {
    if (out.length >= SOURCES_MAX) break;
    if (!s || typeof s !== "object" || typeof (s as { url?: unknown }).url !== "string") continue;
    let u: URL;
    try { u = new URL(((s as { url: string }).url).trim()); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.username = "";
    u.password = "";
    u.hash = "";
    const rawTitle = typeof (s as { title?: unknown }).title === "string" ? (s as { title: string }).title.replace(/\s+/g, " ").trim() : "";
    out.push({ title: clip(rawTitle || u.hostname, SOURCE_TITLE_MAX), url: clip(u.href, SOURCE_URL_MAX), host: u.hostname });
  }
  return out;
}

/** Diff of an edit_file (oldString -> newString, common leading/trailing lines trimmed, DIFF_CONTEXT context lines) or write_file (all `+`) call. Pure.
    undefined for other tools, bad arguments and no change. Lines are capped, `truncated` says when anything was cut. */
export function buildDiff(tool: string, args: Record<string, unknown>): TranscriptDiff | undefined {
  if (typeof args.path !== "string") return undefined;
  let parts: Array<[" " | "+" | "-", string[]]>;
  let removed = 0;
  let added = 0;
  if (tool === "write_file" && typeof args.content === "string") {
    const ls = args.content === "" ? [] : args.content.replace(/\r?\n$/, "").split(/\r?\n/);
    parts = [["+", ls]];
    added = ls.length;
  } else if (tool === "edit_file" && typeof args.oldString === "string" && typeof args.newString === "string") {
    const a = args.oldString.split("\n");
    const b = args.newString.split("\n");
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const del = a.slice(pre, a.length - suf);
    const ins = b.slice(pre, b.length - suf);
    if (!del.length && !ins.length) return undefined;
    removed = del.length;
    added = ins.length;
    parts = [
      [" ", a.slice(Math.max(0, pre - DIFF_CONTEXT), pre)], ["-", del], ["+", ins],
      [" ", a.slice(a.length - suf, a.length - suf + Math.min(DIFF_CONTEXT, suf))],
    ];
  } else return undefined;
  if (!added && !removed) return undefined;

  const lines: string[] = [];
  let truncated = false;
  for (const [sign, ls] of parts) for (const l of ls) {
    if (lines.length >= DIFF_MAX_LINES) { truncated = true; break; }
    const line = sign + l;
    if (line.length > DIFF_LINE_MAX) truncated = true;
    lines.push(clip(line, DIFF_LINE_MAX));
  }
  const path = clip(args.path, DIFF_PATH_MAX);
  if (path.length < args.path.length) truncated = true;
  return { path, added, removed, ...(truncated ? { truncated: true } : {}), lines };
}

export function toolItem(messageId: string, call: Pick<ToolCall, "id" | "name" | "arguments" | "status" | "decidedBy" | "durationMs">): TranscriptItem {
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
  const status = (["pending", "running", "done", "error", "denied"] as const).includes(call.status) ? call.status : "error";
  // no diff for a call that was refused or failed
  const diff = status === "denied" || status === "error" ? undefined : buildDiff(String(call.name), args);
  return {
    kind: "tool", id: `${messageId}:${call.id}`, tool: String(call.name).slice(0, 60), summary: callSummary(String(call.name), args), status,
    ...(call.decidedBy ? { decidedBy: String(call.decidedBy).slice(0, 100) } : {}),
    ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) ? { durationMs: Math.round(call.durationMs) } : {}),
    ...(diff ? { diff } : {}),
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
  /** text / reasoning lengths of the answer as last sent (null before its first frame) */
  private sent: { text: number; reasoning: number } | null = null;
  private lastSent = 0;
  private timer: NodeJS.Timeout | null = null;
  private ended = false;
  private readonly aid: string;
  private sources: TranscriptSource[] = [];

  constructor(private readonly o: FeedOptions) {
    this.aid = o.assistantMessageId;
    const u = o.userMessageId ? getMessageRow(o.userMessageId) : undefined;
    this.user = u ? { kind: "user", id: u.id, text: clip(String(u.content ?? ""), MAX_TEXT) } : null;
    feeds.set(o.conversationId, this);
    this.mark(this.user ? this.user.id! : "", this.aid);
  }

  setRunId(id: string): void { this.runId = id; }
  /** The sources of the answer; sent with the final frame (streaming frames carry none). */
  setSources(list: unknown): void { if (this.ended) return; this.sources = toTranscriptSources(list); this.mark(this.aid); }
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
    return { kind: "assistant", id: this.aid, text: this.text, ...(this.reasoning ? { reasoning: this.reasoning } : {}), status: this.status, ...(this.sources.length ? { sources: this.sources } : {}) };
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
      const deltas = items.map((it) => this.deltaOf(it));
      const frame = (list: TranscriptItem[]) => ({ type: "transcript", conversationId: this.o.conversationId, ...(this.runId ? { runId: this.runId } : {}), items: list });
      sendToChatInstancesBy(this.o.userId, this.o.bridge, (caps) => frame(caps.transcriptDelta ? deltas : items));
      for (const it of items) if (it.kind === "assistant") this.sent = { text: it.text.length, reasoning: it.reasoning?.length ?? 0 };
    }
    if (this.ended && this.dirty.size === 0 && feeds.get(this.o.conversationId) === this) feeds.delete(this.o.conversationId);
  }

  /** The item as a delta frame: while streaming, after the first frame of the answer, only the text added since the last frame. Other items as they are. */
  private deltaOf(it: TranscriptItem): TranscriptItem {
    if (it.kind !== "assistant" || it.status !== "streaming" || !this.sent) return it;
    const reasoning = it.reasoning ?? "";
    const reasoningChanged = reasoning.length !== this.sent.reasoning;
    return {
      kind: "assistant", id: it.id, text: it.text.slice(this.sent.text), from: this.sent.text, status: it.status,
      ...(reasoningChanged ? { reasoning: reasoning.slice(this.sent.reasoning), reasoningFrom: this.sent.reasoning } : {}),
    };
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
    let sources: TranscriptSource[] = [];
    try { sources = toTranscriptSources(r.sources ? JSON.parse(r.sources) : null); } catch { /* no sources */ }
    items.push({
      kind: "assistant", id: r.id, text: clip(String(r.content ?? ""), MAX_TEXT),
      ...(typeof r.reasoning === "string" && r.reasoning ? { reasoning: clip(r.reasoning, MAX_TEXT) } : {}), status: statusOf(r.status),
      ...(sources.length ? { sources } : {}),
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
