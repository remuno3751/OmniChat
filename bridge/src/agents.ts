import fs from "node:fs";
import { findSessionLog, decodeFrames } from "./mirror.js";
import type { DshEvent } from "./dsh.js";

export interface AgentInfo {
  id: string;
  role: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt: number | null;
  summary?: string;
  log?: string;
}

interface Entry {
  info: AgentInfo;
  /** subagent_fork: one-shot, its tool_result carries the answer. */
  fork: boolean;
  prompt: string;
  /** Continuable subagent: id of the child dsh session (from "started subagent <id>"). */
  childId: string | null;
}

const ROLE_MAX = 120;
const SUMMARY_MAX = 500;
const ERROR_MAX = 300;
const ARGS_MAX = 120;
const FAIL_MAX = 120;
const LOG_MAX = 64 * 1024;
const TRUNC_MARK = "\n... [truncated]";

type Rec = Record<string, any>;

function isObj(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Cuts a string to at most `n` UTF-16 units without leaving a lone high surrogate at the end. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/** Keeps the longest prefix whose UTF-8 size fits LOG_MAX (never splitting a character), then marks truncation. */
function capLog(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= LOG_MAX) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= LOG_MAX) lo = mid;
    else hi = mid - 1;
  }
  return cut(s, lo) + TRUNC_MARK;
}

function resultText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => isObj(c) && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function parseRecords(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (isObj(v)) out.push(v);
    } catch {
      /* partial or garbage line: skip */
    }
  }
  return out;
}

function lastIndex(recs: Rec[], pred: (r: Rec) => boolean): number {
  for (let i = recs.length - 1; i >= 0; i--) if (pred(recs[i])) return i;
  return -1;
}

function lastAssistantText(recs: Rec[]): string {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.type !== "assistant/message") continue;
    const content = r.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j];
      if (isObj(c) && c.type === "text" && typeof c.text === "string" && c.text.trim()) return c.text;
    }
  }
  return "";
}

/** Readable transcript of a child session: assistant text, tool calls and failed tool results. */
function buildTranscript(recs: Rec[]): string {
  const blocks: string[] = [];
  for (const r of recs) {
    const d = isObj(r.data) ? r.data : {};
    switch (r.type) {
      case "assistant/message": {
        const content = d.message?.content;
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (isObj(c) && c.type === "text" && typeof c.text === "string" && c.text.trim()) blocks.push(c.text.trim());
        }
        break;
      }
      case "tool/call": {
        const name = String(d.name ?? "tool");
        const args = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? {}) ?? "";
        blocks.push(`> tool ${name} ${cut(args, ARGS_MAX)}`);
        break;
      }
      case "tool/result": {
        const text = textOf(d.message?.content);
        if (text.startsWith("Error")) blocks.push(`> failed: ${cut(text, FAIL_MAX)}`);
        break;
      }
      default:
        break;
    }
  }
  return blocks.join("\n\n");
}

/** Reads a child session log; null if no log exists. Partial or undecodable data yields "". */
function readChildText(dshHome: string, childId: string): string | null {
  const file = findSessionLog(dshHome, childId);
  if (!file) return null;
  try {
    return decodeFrames(fs.readFileSync(file)).text;
  } catch {
    return "";
  }
}

export class AgentTracker {
  private readonly dshHome: string;
  private readonly now: () => number;
  private readonly onChange?: (agents: AgentInfo[]) => void;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: { dshHome: string; now?: () => number; onChange?: (agents: AgentInfo[]) => void }) {
    this.dshHome = opts.dshHome;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
  }

  /** Feed EVERY NDJSON event of the run, in order. Never throws. */
  onEvent(ev: DshEvent): void {
    try {
      if (!isObj(ev)) return;
      if (ev.type === "tool_call") this.onToolCall(ev);
      else if (ev.type === "tool_result") this.onToolResult(ev);
    } catch {
      /* unknown or odd event: ignore */
    }
  }

  /** Copies, in start order. */
  list(): AgentInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  /** Call once after the dsh process ended, before sending `done`. Never throws. */
  finalize(): void {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.info.status !== "running") continue;
      changed = true;
      try {
        this.settle(e);
      } catch {
        this.setError(e, "interrupted: the sub-agent could not be read");
      }
    }
    if (changed) this.notify();
  }

  private notify(): void {
    try {
      this.onChange?.(this.list());
    } catch {
      /* listener errors must not break the run */
    }
  }

  private onToolCall(ev: Rec): void {
    const callId = ev.callId;
    const tool = ev.tool;
    if (typeof callId !== "string" || !callId) return;
    if (typeof tool !== "string" || !tool.startsWith("subagent")) return;
    if (this.entries.has(callId)) return;
    const input = isObj(ev.input) ? ev.input : {};
    const desc = typeof input.description === "string" ? input.description.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    this.entries.set(callId, {
      info: { id: callId, role: desc ? cut(desc, ROLE_MAX) : tool, status: "running", startedAt: this.now(), endedAt: null },
      fork: tool === "subagent_fork",
      prompt,
      childId: null,
    });
    this.notify();
  }

  private onToolResult(ev: Rec): void {
    const callId = ev.callId;
    if (typeof callId !== "string") return;
    const e = this.entries.get(callId);
    if (!e || e.info.status !== "running") return;
    const status = ev.status;
    const result = resultText(ev.result);

    if (e.fork) {
      if (status === "completed") this.setDone(e, result);
      else this.setError(e, cut(result, ERROR_MAX), result);
    } else if (status === "error") {
      this.setError(e, cut(result, ERROR_MAX), result);
    } else {
      const m = /started subagent (\S+)/.exec(result);
      if (m) e.childId = m[1];
      else this.setDone(e, result);
    }
    this.notify();
  }

  private setDone(e: Entry, result: string): void {
    e.info.status = "done";
    e.info.endedAt = this.now();
    e.info.summary = cut(result, SUMMARY_MAX);
    e.info.log = capLog(`# task\n${e.prompt}\n\n# result\n${result}`);
  }

  private setError(e: Entry, summary: string, result?: string): void {
    e.info.status = "error";
    e.info.endedAt = this.now();
    e.info.summary = summary;
    if (result !== undefined) e.info.log = capLog(`# task\n${e.prompt}\n\n# result\n${result}`);
  }

  private settle(e: Entry): void {
    if (!e.childId) {
      this.setError(e, "interrupted before the sub-agent started");
      return;
    }
    const text = readChildText(this.dshHome, e.childId);
    if (text === null) {
      this.setError(e, "sub-agent session log not found");
      e.info.log = "";
      return;
    }
    const recs = parseRecords(text);
    e.info.log = capLog(buildTranscript(recs));

    const startIdx = lastIndex(recs, (r) => r.type === "turn/start");
    const endIdx = lastIndex(recs, (r) => r.type === "turn/end");
    if (endIdx < 0 || endIdx < startIdx) {
      this.setError(e, "interrupted: the dsh process exited before the sub-agent finished");
      return;
    }
    const end = recs[endIdx];
    const reason = isObj(end.data?.reason) ? end.data.reason : {};
    const kind = String(reason.kind ?? "completed");
    e.info.endedAt = typeof end.time === "number" ? end.time : this.now();
    if (kind === "completed") {
      e.info.status = "done";
      e.info.summary = cut(lastAssistantText(recs), SUMMARY_MAX);
    } else {
      const msg = reason.error?.message;
      e.info.status = "error";
      e.info.summary = cut(typeof msg === "string" && msg ? msg : kind, SUMMARY_MAX);
    }
  }
}
