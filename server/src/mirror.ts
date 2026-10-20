import { randomUUID } from "node:crypto";
import { db, nextSeq, toConversation, toMessage, getConversationRow, getMessageRow, insertMessage } from "./db.js";
import type { Message } from "./db.js";
import { broadcast } from "./hub.js";
import { lastMessageId } from "./branching.js";
import { isValidCwd } from "./cwd.js";

/* Two-way sync with the dsh GUI: applies `sessions` frames sent by a bridge (see BRIDGE-v2.md, B). */

const MAX_SESSIONS = 100;
const MAX_MESSAGES = 300;
const MAX_TEXT = 200_000;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_RE = /^(?:u:\d{1,9}:\d{1,6}|a:\d{1,9})$/;

interface MirrorMessage { key: string; role: "user" | "assistant"; text: string; createdAt: number; status: Message["status"] }
interface MirrorSession { sessionId: string; cwd: string; title: string | null; updatedAt: number; messages: MirrorMessage[] }

// ---------- active server runs ----------

export interface RunInfo {
  userId: string;
  bridgeName: string;
  conversationId: string;
  sessionId: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
}
const activeRuns = new Set<RunInfo>();

export function registerRun(info: RunInfo) {
  const run = { ...info };
  activeRuns.add(run);
  return {
    setSession(id: string) { run.sessionId = id; },
    /** Record u:<turn>:0 / a:<turn> -> this run's message ids (origin 'app'). */
    linkTurn(turn: number) {
      if (!run.sessionId || !run.userMessageId || !run.assistantMessageId) return;
      if (!Number.isInteger(turn) || turn < 0 || turn > 999_999_999) return;
      const ins = db.prepare(
        "INSERT OR REPLACE INTO mirror_map (user_id, bridge_name, session_id, key, message_id, origin) VALUES (?,?,?,?,?, 'app')",
      );
      ins.run(run.userId, run.bridgeName, run.sessionId, `u:${turn}:0`, run.userMessageId);
      ins.run(run.userId, run.bridgeName, run.sessionId, `a:${turn}`, run.assistantMessageId);
    },
    end() { activeRuns.delete(run); },
  };
}

function runBlocks(userId: string, bridgeName: string, sessionId: string): boolean {
  for (const r of activeRuns) {
    if (r.userId !== userId || r.bridgeName !== bridgeName) continue;
    if (r.sessionId === sessionId) return true;
    if (r.sessionId === null) {
      // A brand new session is being created by this run; its id is not known yet.
      const known = db.prepare("SELECT 1 FROM agent_sessions WHERE session_id = ?").get(sessionId);
      if (!known) return true;
    }
  }
  return false;
}

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e14 ? Math.floor(v) : dflt);
const STATUSES = new Set(["done", "streaming", "error", "stopped"]);

function parseSessions(raw: unknown): MirrorSession[] {
  if (!Array.isArray(raw)) return [];
  const out: MirrorSession[] = [];
  for (const s of raw.slice(0, MAX_SESSIONS)) {
    if (!isObj(s) || typeof s.sessionId !== "string" || !SESSION_ID_RE.test(s.sessionId) || !Array.isArray(s.messages)) continue;
    const msgs: MirrorMessage[] = [];
    const seen = new Set<string>();
    for (const m of s.messages.slice(-MAX_MESSAGES)) {
      if (!isObj(m) || typeof m.key !== "string" || !KEY_RE.test(m.key) || seen.has(m.key)) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (typeof m.text !== "string") continue;
      const status = m.role === "user" ? "done" : STATUSES.has(m.status) ? (m.status as Message["status"]) : "done";
      seen.add(m.key);
      msgs.push({ key: m.key, role: m.role, text: m.text.slice(0, MAX_TEXT), createdAt: num(m.createdAt, Date.now()), status });
    }
    out.push({
      sessionId: s.sessionId,
      cwd: typeof s.cwd === "string" ? s.cwd.slice(0, 1000) : "",
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 200) : null,
      updatedAt: num(s.updatedAt, Date.now()),
      messages: msgs,
    });
  }
  return out;
}

// ---------- applying ----------

function deriveTitle(s: MirrorSession): string {
  if (s.title) return s.title.slice(0, 80);
  const first = s.messages.find((m) => m.role === "user" && m.text.trim());
  if (first) return first.text.trim().replace(/\s+/g, " ").slice(0, 40);
  return "dsh session";
}

function applySession(userId: string, bridgeName: string, s: MirrorSession): void {
  const convs: any[] = [];
  const msgs: Message[] = [];
  db.exec("BEGIN");
  try {
    // Find / create the conversation.
    const link = db
      .prepare(
        "SELECT a.conversation_id AS id FROM agent_sessions a JOIN conversations c ON c.id = a.conversation_id " +
        "WHERE a.session_id = ? AND c.user_id = ? LIMIT 1",
      )
      .get(s.sessionId, userId) as { id: string } | undefined;
    let convId: string;
    let createdConv = false;
    if (link) {
      convId = link.id;
    } else {
      convId = "dsh-" + s.sessionId;
      const existing = getConversationRow(convId);
      if (existing && existing.user_id !== userId) { db.exec("ROLLBACK"); return; }
      if (!existing) {
        const prov = db
          .prepare(
            "SELECT id FROM providers WHERE user_id = ? AND kind = 'dsh-bridge' AND deleted = 0 AND base_url = ? ORDER BY created_at, seq LIMIT 1",
          )
          .get(userId, bridgeName) as { id: string } | undefined;
        const created = s.messages.length ? Math.min(...s.messages.map((m) => m.createdAt)) : Date.now();
        db.prepare(
          "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, mode) VALUES (?,?,?,?,NULL,?,?,0,?,'code')",
        ).run(convId, userId, deriveTitle(s), prov?.id ?? null, created, Math.max(created, s.updatedAt), nextSeq());
        createdConv = true;
      }
      db.prepare(
        "INSERT INTO agent_sessions (conversation_id, provider_id, session_id) VALUES (?,?,?) " +
        "ON CONFLICT(conversation_id) DO UPDATE SET session_id = excluded.session_id",
      ).run(convId, (getConversationRow(convId).provider_id as string | null) ?? "", s.sessionId);
    }
    const conv = getConversationRow(convId);
    if (!conv || conv.deleted) { db.exec("ROLLBACK"); return; }

    const getMap = db.prepare("SELECT message_id, origin FROM mirror_map WHERE user_id = ? AND session_id = ? AND key = ?");
    const putMap = db.prepare(
      "INSERT OR REPLACE INTO mirror_map (user_id, bridge_name, session_id, key, message_id, origin) VALUES (?,?,?,?,?, 'dsh')",
    );
    let changed = createdConv;
    // dsh sessions are linear: chain parentId in order; head stays at the last message.
    let tail: string | null = (conv.head_id as string | null) ?? lastMessageId(convId);
    for (const m of s.messages) {
      const map = getMap.get(userId, s.sessionId, m.key) as { message_id: string; origin: string } | undefined;
      if (map) {
        if (getMessageRow(map.message_id)?.conversation_id === convId) tail = map.message_id;
        if (map.origin === "app") continue;
        const cur = getMessageRow(map.message_id);
        if (!cur || cur.user_id !== userId) continue;
        if (cur.content === m.text && cur.status === m.status) continue;
        db.prepare("UPDATE messages SET content = ?, status = ?, seq = ? WHERE id = ?").run(m.text, m.status, nextSeq(), map.message_id);
        msgs.push(toMessage(getMessageRow(map.message_id)));
        changed = true;
      } else {
        const id = randomUUID();
        const row = insertMessage(userId, {
          id, conversationId: convId, role: m.role, content: m.text, status: m.status, createdAt: m.createdAt, parentId: tail,
        });
        tail = id;
        putMap.run(userId, bridgeName, s.sessionId, m.key, id);
        msgs.push(row);
        changed = true;
      }
    }
    // Working folder (Code workspaces): the dsh GUI's cwd; also backfills conversations that predate the column.
    if (isValidCwd(s.cwd) && conv.cwd !== s.cwd) {
      db.prepare("UPDATE conversations SET cwd = ? WHERE id = ?").run(s.cwd, convId);
      changed = true;
    }
    if (tail && tail !== conv.head_id) {
      db.prepare("UPDATE conversations SET head_id = ? WHERE id = ?").run(tail, convId);
      changed = true;
    }
    // Title from dsh for conversations we created.
    let title = conv.title as string;
    if (convId.startsWith("dsh-") && s.title && s.title !== title) { title = s.title.slice(0, 80); changed = true; }
    if (changed) {
      db.prepare("UPDATE conversations SET title = ?, updated_at = ?, seq = ? WHERE id = ?")
        .run(title, Math.max(conv.updated_at as number, s.updatedAt), nextSeq(), convId);
      convs.push(toConversation(getConversationRow(convId)));
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
  if (convs.length || msgs.length) {
    broadcast(userId, { type: "upsert", ...(convs.length ? { conversations: convs } : {}), ...(msgs.length ? { messages: msgs } : {}) });
  }
}

/** Entry point for a bridge `sessions` frame. Never throws. */
export function handleSessionsFrame(userId: string, bridgeName: string, frame: unknown): void {
  try {
    if (!isObj(frame)) return;
    for (const s of parseSessions(frame.sessions)) {
      if (runBlocks(userId, bridgeName, s.sessionId)) continue;
      try { applySession(userId, bridgeName, s); } catch (e) { console.error("mirror: apply failed", e); }
    }
  } catch (e) {
    console.error("mirror: bad frame", e);
  }
}

/** Bridge went away: its dsh-originated streaming messages become errors. */
export function handleBridgeDisconnect(userId: string, bridgeName: string): void {
  try {
    const rows = db
      .prepare(
        "SELECT m.* FROM messages m JOIN mirror_map x ON x.message_id = m.id " +
        "WHERE x.user_id = ? AND x.bridge_name = ? AND x.origin = 'dsh' AND m.status = 'streaming'",
      )
      .all(userId, bridgeName) as any[];
    if (!rows.length) return;
    const msgs: Message[] = [];
    const convIds = new Set<string>();
    for (const r of rows) {
      db.prepare("UPDATE messages SET status = 'error', seq = ? WHERE id = ?").run(nextSeq(), r.id);
      msgs.push(toMessage(getMessageRow(r.id)));
      convIds.add(r.conversation_id);
    }
    const convs = [];
    for (const id of convIds) {
      db.prepare("UPDATE conversations SET updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), id);
      convs.push(toConversation(getConversationRow(id)));
    }
    broadcast(userId, { type: "upsert", conversations: convs, messages: msgs });
  } catch (e) {
    console.error("mirror: disconnect handling failed", e);
  }
}
