import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface MirrorMessage {
  key: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  status: "done" | "streaming" | "error" | "stopped";
}

export interface MirrorSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: number;
  messages: MirrorMessage[];
}

export interface SessionsFrame {
  type: "sessions";
  full: boolean;
  sessions: MirrorSession[];
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const LOG_NAME = "session.v4.jsonl.zstd";
const MAX_MESSAGES = 300;
const MAX_FULL_SESSIONS = 30;

class FormatError extends Error {}

// ---------------------------------------------------------------- frame decoding

/**
 * Length of the zstd frame starting at `p` by walking its header and block headers
 * (zlib's decoder silently returns partial output for truncated input, so completeness must be checked here).
 * Returns null if the frame is not completely present yet.
 */
export function zstdFrameLength(buf: Buffer, p: number): number | null {
  const n = buf.length;
  let i = p + 4;
  if (i >= n) return null;
  const fhd = buf[i++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) i += 1; // window descriptor
  i += [0, 1, 2, 4][dictFlag];
  i += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (i + 3 > n) return null;
    const h = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >> 3;
    if (type === 3) throw new FormatError("invalid zstd block");
    i += 3 + (type === 1 ? 1 : size);
    if (i > n) return null;
    if (last) break;
  }
  if (checksum) i += 4;
  return i > n ? null : i - p;
}

/**
 * Decodes as many complete zstd frames as possible from `buf` (which must start at a frame boundary).
 * Returns the decoded text and the number of bytes consumed; an incomplete trailing frame is left unconsumed.
 */
export function decodeFrames(buf: Buffer): { text: string; consumed: number } {
  const parts: string[] = [];
  let p = 0;
  const n = buf.length;
  while (p < n) {
    if (n - p < 4) break; // magic only partially written
    if (buf.compare(MAGIC, 0, 4, p, p + 4) !== 0) throw new FormatError("log does not start with a zstd frame");
    const len = zstdFrameLength(buf, p);
    if (len === null) break; // partial trailing frame; retry next poll
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(p, p + len)).toString("utf8"));
    } catch {
      throw new FormatError("undecodable zstd frame");
    }
    p += len;
  }
  return { text: parts.join(""), consumed: p };
}

// ---------------------------------------------------------------- session model

interface TurnAgg {
  turn: number;
  createdAt: number;
  order: number;
  text: string;
  end: string | null;
  errorMessage?: string;
}

function shortArgs(args: unknown): string {
  let s: string;
  if (typeof args === "string") {
    try { s = JSON.stringify(JSON.parse(args)); } catch { s = args; }
  } else {
    s = JSON.stringify(args ?? {});
  }
  return s.slice(0, 120);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string")
    .map((c) => (c as any).text as string)
    .join("\n");
}

export class SessionModel {
  sessionId = "";
  cwd = "";
  title: string | null = null;
  private curTurn = 0;
  private order = 0;
  private users = new Map<string, MirrorMessage & { order: number }>();
  private userIds = new Set<string>();
  private userCount = new Map<number, number>();
  private turns = new Map<number, TurnAgg>();
  private calls = new Map<string, string>();

  get hasHuman(): boolean {
    return this.users.size > 0;
  }

  private turnAgg(turn: number, time: number): TurnAgg {
    let t = this.turns.get(turn);
    if (!t) {
      t = { turn, createdAt: time, order: this.order++, text: "", end: null };
      this.turns.set(turn, t);
    }
    return t;
  }

  add(rec: any): void {
    if (!rec || typeof rec !== "object") throw new FormatError("record is not an object");
    const d = rec.data ?? {};
    const time = typeof rec.time === "number" ? rec.time : 0;
    switch (rec.type) {
      case "session":
        if (typeof rec.id === "string") this.sessionId = rec.id;
        if (typeof rec.cwd === "string") this.cwd = rec.cwd;
        break;
      case "turn/start":
        if (typeof d.turn === "number") this.curTurn = d.turn;
        break;
      case "turn/end": {
        if (typeof d.turn !== "number") break;
        const kind = String(d.reason?.kind ?? "completed");
        const t = this.turnAgg(d.turn, time);
        t.end = kind === "completed" ? "done" : kind === "error" ? "error" : "stopped";
        t.errorMessage = d.reason?.error?.message;
        break;
      }
      case "user/message": {
        if (d.source?.kind !== "user" || d.role !== "user") break;
        const id = typeof d.id === "string" ? d.id : null;
        if (id && this.userIds.has(id)) break;
        if (id) this.userIds.add(id);
        const k = this.userCount.get(this.curTurn) ?? 0;
        this.userCount.set(this.curTurn, k + 1);
        const key = `u:${this.curTurn}:${k}`;
        this.users.set(key, { key, role: "user", text: textOf(d.content), createdAt: time, status: "done", order: this.order++ });
        break;
      }
      case "assistant/message": {
        if (typeof d.turn !== "number") break;
        const t = this.turnAgg(d.turn, time);
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c && c.type === "text" && typeof c.text === "string") t.text += c.text;
          }
        }
        break;
      }
      case "tool/call": {
        if (typeof d.turn !== "number") break;
        const t = this.turnAgg(d.turn, time);
        const name = String(d.name ?? "tool");
        if (typeof d.callId === "string") this.calls.set(d.callId, name);
        t.text += `\n\n> 🔧 ${name} ${shortArgs(d.arguments)}\n\n`;
        break;
      }
      case "tool/result": {
        if (typeof d.turn !== "number") break;
        const t = this.turnAgg(d.turn, time);
        const text = textOf(d.message?.content);
        if (text.startsWith("Error")) {
          const callId = d.message?.toolCallId ?? d.message?.source?.callId ?? d.callId;
          const name = (typeof callId === "string" && this.calls.get(callId)) || "tool";
          t.text += `> ⚠️ ${name} failed: ${text.slice(0, 120)}\n\n`;
        }
        break;
      }
      case "session/title":
        if (typeof d.title === "string") this.title = d.title;
        break;
      default:
        break;
    }
  }

  messages(): MirrorMessage[] {
    const all: Array<MirrorMessage & { order: number }> = [...this.users.values()];
    for (const t of this.turns.values()) {
      const text = t.text || (t.end === "error" && t.errorMessage ? `⚠️ ${t.errorMessage}` : "");
      if (!text) continue;
      all.push({
        key: `a:${t.turn}`,
        role: "assistant",
        text,
        createdAt: t.createdAt,
        status: (t.end ?? "streaming") as MirrorMessage["status"],
        order: t.order,
      });
    }
    all.sort((a, b) => a.order - b.order);
    return all.map(({ order: _o, ...m }) => m);
  }
}

// ---------------------------------------------------------------- per-file incremental reader

class LogState {
  offset = 0; // start of the first not-yet-decoded frame
  tail = ""; // trailing partial JSONL line
  model = new SessionModel();
  mtimeMs = 0;
  size = 0;
  dirty = false;
  ignored = false;
}

function feed(st: LogState, buf: Buffer): void {
  const { text, consumed } = decodeFrames(buf);
  st.offset += consumed;
  if (!text) return;
  const lines = (st.tail + text).split("\n");
  st.tail = lines.pop() ?? "";
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let rec: unknown;
    try { rec = JSON.parse(s); } catch { throw new FormatError("unparsable record"); }
    st.model.add(rec);
  }
  st.dirty = true;
}

function readFrom(file: string, offset: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    let got = 0;
    while (got < buf.length) {
      const r = fs.readSync(fd, buf, got, buf.length - got, offset + got);
      if (r <= 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function normCwd(p: string): string {
  let r = path.resolve(p).replace(/[\\/]+$/, "");
  if (process.platform === "win32") r = r.toLowerCase();
  return r;
}

/** Locates the session.v4.jsonl.zstd of a session under <dshHome>/sessions (any cwd slug). */
export function findSessionLog(dshHome: string, sessionId: string): string | null {
  if (!/^[\w.-]+$/.test(sessionId)) return null;
  const root = path.join(dshHome, "sessions");
  let slugs: string[];
  try { slugs = fs.readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const f = path.join(root, slug, sessionId, LOG_NAME);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function sessionLogMtime(dshHome: string, sessionId: string): number | null {
  const f = findSessionLog(dshHome, sessionId);
  if (!f) return null;
  try { return fs.statSync(f).mtimeMs; } catch { return null; }
}

// ---------------------------------------------------------------- mirror

export interface MirrorOptions {
  dshHome: string;
  cwd: string;
  mirrorAll?: boolean;
  warn?: (msg: string) => void;
  maxFullSessions?: number;
  maxMessages?: number;
}

export class Mirror {
  disabled = false;
  private files = new Map<string, LogState | { mtimeMs: number; size: number }>();
  private sent = new Map<string, { title: string | null; msgs: Map<string, string> }>();
  private warned = false;
  private readonly cwdNorm: string;
  private readonly warn: (m: string) => void;

  constructor(private o: MirrorOptions) {
    this.cwdNorm = normCwd(o.cwd);
    this.warn = o.warn ?? ((m) => console.error(m));
  }

  private listLogs(): Array<{ file: string; mtimeMs: number; size: number }> {
    const root = path.join(this.o.dshHome, "sessions");
    const out: Array<{ file: string; mtimeMs: number; size: number }> = [];
    let slugs: string[];
    try { slugs = fs.readdirSync(root); } catch { return out; }
    for (const slug of slugs) {
      let sess: string[];
      try { sess = fs.readdirSync(path.join(root, slug)); } catch { continue; }
      for (const s of sess) {
        if (!s.startsWith("session-")) continue;
        const file = path.join(root, slug, s, LOG_NAME);
        try {
          const st = fs.statSync(file);
          out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* no log yet */ }
      }
    }
    return out;
  }

  private matches(st: LogState): boolean {
    if (!st.model.sessionId) return false;
    return !!this.o.mirrorAll || normCwd(st.model.cwd || ".") === this.cwdNorm;
  }

  /** Re-reads changed logs. `limit`: on first sight, process at most this many matching sessions (newest first). */
  private scan(limit?: number): void {
    const logs = this.listLogs().sort((a, b) => b.mtimeMs - a.mtimeMs);
    let matched = 0;
    for (const l of logs) {
      const known = this.files.get(l.file);
      if (known && known.mtimeMs === l.mtimeMs && known.size === l.size) {
        if (known instanceof LogState && !known.ignored && this.matches(known)) matched++;
        continue;
      }
      if (limit !== undefined && !known && matched >= limit) {
        this.files.set(l.file, { mtimeMs: l.mtimeMs, size: l.size });
        continue;
      }
      let st = known instanceof LogState ? known : new LogState();
      if (st.ignored) {
        st.mtimeMs = l.mtimeMs;
        st.size = l.size;
        continue;
      }
      try {
        if (l.size < st.offset) st = new LogState(); // truncated/rewritten
        feed(st, readFrom(l.file, st.offset));
      } catch (e) {
        if (e instanceof FormatError) {
          this.disable(`${e.message} (${l.file})`);
          return;
        }
        continue; // transient fs error: retry next poll
      }
      st.mtimeMs = l.mtimeMs;
      st.size = l.size;
      this.files.set(l.file, st);
      if (!this.matches(st)) {
        if (st.model.sessionId) st.ignored = true;
        continue;
      }
      matched++;
    }
  }

  private disable(reason: string): void {
    this.disabled = true;
    if (!this.warned) {
      this.warned = true;
      this.warn(`[bridge] warning: dsh session log format not understood, mirroring disabled: ${reason}`);
    }
  }

  private active(): LogState[] {
    const r: LogState[] = [];
    for (const st of this.files.values()) {
      if (st instanceof LogState && !st.ignored && this.matches(st) && st.model.hasHuman) r.push(st);
    }
    return r;
  }

  private toSession(st: LogState, msgs: MirrorMessage[]): MirrorSession {
    return { sessionId: st.model.sessionId, cwd: st.model.cwd, title: st.model.title, updatedAt: Math.round(st.mtimeMs), messages: msgs };
  }

  /** Full snapshot (call after (re)connect). Resets delta tracking. */
  full(): SessionsFrame | null {
    if (this.disabled) return null;
    this.scan(this.o.maxFullSessions ?? MAX_FULL_SESSIONS);
    if (this.disabled) return null;
    const cap = this.o.maxMessages ?? MAX_MESSAGES;
    const list = this.active().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.o.maxFullSessions ?? MAX_FULL_SESSIONS);
    this.sent.clear();
    const sessions: MirrorSession[] = [];
    for (const st of list) {
      const msgs = st.model.messages().slice(-cap);
      this.sent.set(st.model.sessionId, { title: st.model.title, msgs: new Map(msgs.map((m) => [m.key, sig(m)])) });
      st.dirty = false;
      sessions.push(this.toSession(st, msgs));
    }
    return { type: "sessions", full: true, sessions };
  }

  /** Delta since the last full()/poll(); null if nothing changed. */
  poll(): SessionsFrame | null {
    if (this.disabled) return null;
    this.scan();
    if (this.disabled) return null;
    const cap = this.o.maxMessages ?? MAX_MESSAGES;
    const sessions: MirrorSession[] = [];
    for (const st of this.active()) {
      if (!st.dirty) continue;
      st.dirty = false;
      const id = st.model.sessionId;
      const prev = this.sent.get(id);
      const msgs = st.model.messages().slice(-cap);
      const changed = msgs.filter((m) => prev?.msgs.get(m.key) !== sig(m));
      const titleChanged = !prev || prev.title !== st.model.title;
      if (!changed.length && !titleChanged) continue;
      const rec = prev ?? { title: null, msgs: new Map<string, string>() };
      rec.title = st.model.title;
      for (const m of changed) rec.msgs.set(m.key, sig(m));
      this.sent.set(id, rec);
      sessions.push(this.toSession(st, changed));
    }
    return sessions.length ? { type: "sessions", full: false, sessions } : null;
  }
}

function sig(m: MirrorMessage): string {
  return `${m.status}\u0000${m.text}`;
}
