import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DB_PATH as dbPath, DATA_DIR } from "./config.js";
import { migrate as migrateAuth } from "./migrate-auth.js";
import { migrate as migrateChat } from "./migrate-chat.js";
import { migrate as migrateMetrics } from "./migrate-metrics.js";
import { migrate as migrateTools } from "./migrate-tools.js";
import type { ToolCall, SearchSource, SearchMode, GuardNotice } from "./tools/types.js";
import { migrate as migrateFts } from "./migrate-fts.js";
import { migrate as migrateDev } from "./migrate-dev.js";
import { migrate as migrateP5 } from "./migrate-p5.js";
import { migrate as migrateV4 } from "./migrate-v4.js";
import { migrate as migrateAdmin } from "./migrate-admin.js";
import { migrate as migrateSearch } from "./migrate-search.js";
import { migrate as migrateAttachments } from "./migrate-attachments.js";
import { migrate as migratePlugins } from "./migrate-plugins.js";
import { migrate as migrateQuota } from "./migrate-quota.js";
import { migrate as migrateFolders } from "./migrate-folders.js";
import { migrate as migrateVoice } from "./migrate-voice.js";
import { encryptExistingKeys } from "./secret.js";
import { parseResponseFormat } from "./structured.js";
import type { ResponseFormat } from "./structured.js";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

/** Best effort (no-op on Windows): the data directory holds password hashes, API keys and every conversation. */
export function restrictPerms(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* unsupported FS or not the owner */ }
}

/** The real connection. Use `db` (routing wrapper) everywhere else; rawDb is for migrations and the ephemeral store setup. */
export const rawDb = new DatabaseSync(dbPath);
if (dbPath !== ":memory:") {
  restrictPerms(dbPath, 0o600);
  // only the dedicated data directory is locked down; a custom DB_PATH may live in a shared folder
  if (resolve(dirname(dbPath)) === resolve(DATA_DIR)) restrictPerms(DATA_DIR, 0o700);
}
rawDb.exec("PRAGMA journal_mode = WAL;");
// sorter spill files of ORDER BY / temp B-trees must not hit the disk (ephemeral chats)
rawDb.exec("PRAGMA temp_store = MEMORY");

rawDb.exec(`
CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS providers_user_seq ON providers (user_id, seq);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_user_seq ON conversations (user_id, seq);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user_seq ON messages (user_id, seq);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS agent_sessions (
  conversation_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  session_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mirror_map (
  user_id TEXT NOT NULL,
  bridge_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, key)
);
CREATE INDEX IF NOT EXISTS mirror_map_msg ON mirror_map (message_id);
`);

migrateAuth(rawDb);
migrateChat(rawDb);
migrateMetrics(rawDb);
migrateTools(rawDb);
migrateFts(rawDb);
migrateDev(rawDb);
migrateP5(rawDb);
migrateV4(rawDb);
migrateSearch(rawDb);
migrateAdmin(rawDb);
migrateAttachments(rawDb);
migratePlugins(rawDb);
migrateQuota(rawDb);
migrateFolders(rawDb);
migrateVoice(rawDb);
// Stills pets (pets.ts): one row per state image, plus one meta row per pet.
rawDb.exec(`
CREATE TABLE IF NOT EXISTS pet_stills (
  user_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  state TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pet_id, state)
);
CREATE TABLE IF NOT EXISTS pet_stills_meta (
  user_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pet_id)
);
`);
encryptExistingKeys(rawDb);

// ---- ephemeral store (see docs/EPHEMERAL.md) ----
/** Tables whose rows of an ephemeral chat live in the in-memory schema `eph`. */
export const EPH_TABLES: readonly string[] = ["conversations", "messages", "metrics", "checkpoints", "agent_sessions"];
/** Carries the ephemeral chat across async hops; set only by runEphemeral. */
export const ephScope = new AsyncLocalStorage<true>();
export function runEphemeral<T>(fn: () => T): T {
  return ephScope.run(true, fn);
}

const EPH_NAME_SRC = `(?<![.\\w])(${EPH_TABLES.join("|")})(?![\\w])`;

function setupEphStore(conn: DatabaseSync): void {
  try {
    conn.exec("ATTACH DATABASE ':memory:' AS eph");
    conn.exec("PRAGMA eph.secure_delete = ON");
    const list = EPH_TABLES.map((t) => `'${t}'`).join(",");
    const rows = conn
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND ((type = 'table' AND name IN (${list})) OR (type = 'index' AND tbl_name IN (${list})))`,
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
    // tables first, then their indexes
    rows.sort((a, b) => (a.type === b.type ? 0 : a.type === "table" ? -1 : 1));
    for (const r of rows) {
      const ddl = r.type === "table"
        ? r.sql.replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS eph.")
        : r.sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_m, u?: string) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS eph.`);
      conn.exec(ddl);
    }
  } catch (e) {
    throw new Error(`ephemeral store setup failed: ${(e as Error).message}`);
  }
}
setupEphStore(rawDb);

/* eslint-disable @typescript-eslint/no-explicit-any */
const usesEph = (sql: string): boolean => new RegExp(EPH_NAME_SRC).test(sql);
const toEphSql = (sql: string): string => sql.replace(new RegExp(EPH_NAME_SRC, "g"), "eph.$1");
const hasEphArg = (args: unknown[]): boolean => args.some((a) => typeof a === "string" && a.startsWith("eph_"));

function routeStatement(sql: string): any {
  const main: any = rawDb.prepare(sql);
  const routed = usesEph(sql);
  let ephStmt: any;
  const pick = (args: unknown[]): any => {
    if (!routed) return main;
    if (ephScope.getStore() === true || hasEphArg(args)) return (ephStmt ??= rawDb.prepare(toEphSql(sql)));
    return main;
  };
  const explicit = {
    get: (...args: any[]) => pick(args).get(...args),
    all: (...args: any[]) => pick(args).all(...args),
    run: (...args: any[]) => pick(args).run(...args),
    iterate: (...args: any[]) => pick(args).iterate(...args),
  };
  return new Proxy(explicit, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(target, prop)) return (target as any)[prop];
      const v = main[prop];
      return typeof v === "function" ? v.bind(main) : v;
    },
  });
}

/** Routing wrapper over rawDb (see docs/EPHEMERAL.md). Typed as DatabaseSync so callers are unchanged. */
const dbRouter = new Proxy({} as any, {
  get(_t, prop) {
    if (prop === "prepare") return (sql: string) => routeStatement(sql);
    const v = (rawDb as any)[prop];
    return typeof v === "function" ? v.bind(rawDb) : v;
  },
});
export const db = dbRouter as unknown as DatabaseSync;
/* eslint-enable @typescript-eslint/no-explicit-any */

export function nextSeq(): number {
  const row = db
    .prepare("UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value")
    .get() as { value: number };
  return row.value;
}

export function currentSeq(): number {
  return (db.prepare("SELECT value FROM counter WHERE id = 1").get() as { value: number }).value;
}

// Messages left streaming by a previous crash become errors.
{
  const rows = db.prepare("SELECT id FROM messages WHERE status = 'streaming'").all() as { id: string }[];
  const upd = db.prepare(
    "UPDATE messages SET status = 'error', content = CASE WHEN content = '' THEN 'Server restarted during generation' ELSE content END, seq = ? WHERE id = ?",
  );
  for (const r of rows) upd.run(nextSeq(), r.id);
}

export type Effort = "off" | "low" | "medium" | "high" | "max";
export interface SamplingParams {
  temperature?: number | null; topP?: number | null; topK?: number | null; minP?: number | null;
  repeatPenalty?: number | null; seed?: number | null; stop?: string[] | null; maxTokens?: number | null;
  /** top-N logprobs 0..20 */ logprobs?: number | null; /** llama.cpp GBNF */ grammar?: string | null; extraBody?: Record<string, unknown> | null;
}
export interface Conversation {
  id: string; title: string; providerId: string | null; model: string | null;
  createdAt: number; updatedAt: number; deleted: boolean; seq: number;
  projectId: string | null;
  /** chat folder (folders.ts); null = unclassified. Never set on ephemeral chats. */
  folderId: string | null;
  systemPrompt: string | null; systemMode: "append" | "replace";
  effort: Effort | null; params: SamplingParams | null; headId: string | null;
  tools: string[] | null; searchMode: SearchMode | null;
  /** per-chat override of the overflow policy (null = follow the user default) */
  contextOverflow: "truncate" | "summarize" | "stop" | null;
  responseFormat: ResponseFormat | null;
  pinned: boolean; pinnedAt: number | null;
  mode: "chat" | "code"; codeStatus: CodeStatus;
  /** Code (vscode-bridge): how tool calls are approved. Changed only by the user (PUT), never reset by the server. */
  approvalMode: "manual" | "auto" | "full";
  /** Code: working folder of the session on the PC (null = unknown) */
  cwd: string | null;
  /** true iff the id starts with "eph_" (ephemeral chat, memory only) */
  ephemeral: boolean;
  /** which kinds of messages the chat holds: "voice" = Aria call messages (messages.via), "chat" = anything else */
  kinds: ("chat" | "voice")[];
}
export type CodeStatus = "idle" | "running" | "awaiting_approval" | "done" | "error";
export const CODE_STATUSES: readonly CodeStatus[] = ["idle", "running", "awaiting_approval", "done", "error"];
export interface PhaseRecord { id: string; phase: string; label?: string; start: number; end: number | null }
export interface FileChange { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; patch?: string }
export interface AgentRecord { id: string; role: string; status: "running" | "done" | "error"; startedAt: number; endedAt: number | null; summary?: string; log?: string }
export interface Message {
  id: string; conversationId: string; role: "user" | "assistant"; content: string;
  status: "done" | "streaming" | "error" | "stopped"; createdAt: number; seq: number;
  parentId: string | null;
  reasoning: string | null;
  metrics: Metrics | null;
  toolCalls: ToolCall[] | null;
  sources: SearchSource[] | null;
  /** passages the injection guard removed from web content during this answer (omitted when none) */
  guardBlocked?: GuardNotice[] | null;
  phases: PhaseRecord[] | null;
  changes: FileChange[] | null;
  agents: AgentRecord[] | null;
  /** "voice" = made during an Aria voice call; omitted otherwise */
  via?: "voice";
  /** attachment metadata (no bytes, no text); omitted when the message has none */
  attachments?: { id: string; name: string; mime: string; kind: string; size: number; status: string }[];
}
export interface Metrics {
  providerId: string | null; providerKind: string | null; model: string | null; quantization: string | null;
  contextLength: number | null; promptTokens: number; completionTokens: number; reasoningTokens: number;
  ttftMs: number | null; totalMs: number | null; prefillTps: number | null; decodeTps: number | null;
  source: "backend" | "estimated"; createdAt: number;
  /** structured output: did the reply parse (and match the schema)? absent/null = no response format */
  jsonValid?: boolean | null; jsonError?: string;
}
export interface Provider {
  id: string; name: string; kind: string; baseUrl: string; model: string;
  hasKey: boolean; deleted: boolean; seq: number;
  /** how effort is sent to this provider; null = the per-kind map ("standard") */
  effortProfile: string | null;
  /** shared by the admin with other users under their model grants (owner view only; see shared-providers.ts) */
  shared: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const parseJson = (v: any): any => {
  if (typeof v !== "string" || !v) return null;
  try { const o = JSON.parse(v); return o && typeof o === "object" ? o : null; } catch { return null; }
};
export const parseToolList = (v: any): string[] | null => {
  if (typeof v !== "string" || !v) return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : null; } catch { return null; }
};
/** Stored "auto" (removed mode) reads as "smart", which now has its behavior. */
export const parseSearchMode = (v: any): SearchMode | null => (v === "off" || v === "always" || v === "smart" ? v : v === "auto" ? "smart" : null);
const parseJsonArray = (v: any): any[] | null => {
  if (typeof v !== "string" || !v) return null;
  try { const a = JSON.parse(v); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
};
/** "voice" if any message came from a call, "chat" if any did not; an empty chat is ["chat"]. */
function kindsOf(conversationId: string): ("chat" | "voice")[] {
  try {
    const r = db.prepare("SELECT SUM(CASE WHEN via = 'voice' THEN 1 ELSE 0 END) AS v, SUM(CASE WHEN via IS NULL OR via != 'voice' THEN 1 ELSE 0 END) AS c FROM messages WHERE conversation_id = ?").get(conversationId) as { v: number | null; c: number | null };
    const v = Number(r?.v ?? 0) > 0, c = Number(r?.c ?? 0) > 0;
    return v && c ? ["chat", "voice"] : v ? ["voice"] : ["chat"];
  } catch { return ["chat"]; }
}
export const toConversation = (r: any): Conversation => ({
  id: r.id, title: r.title, providerId: r.provider_id ?? null, model: r.model ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq,
  projectId: r.project_id ?? null, folderId: r.folder_id ?? null, systemPrompt: r.system_prompt ?? null,
  systemMode: r.system_mode === "replace" ? "replace" : "append",
  effort: r.effort ?? null, params: parseJson(r.params), headId: r.head_id ?? null,
  tools: parseToolList(r.tools), searchMode: parseSearchMode(r.search_mode),
  contextOverflow: r.context_overflow === "truncate" || r.context_overflow === "summarize" || r.context_overflow === "stop" ? r.context_overflow : null,
  responseFormat: parseResponseFormat(r.response_format),
  pinned: !!r.pinned, pinnedAt: typeof r.pinned_at === "number" ? r.pinned_at : null,
  mode: r.mode === "code" ? "code" : "chat",
  approvalMode: r.approval_mode === "auto" || r.approval_mode === "full" ? r.approval_mode : "manual",
  codeStatus: CODE_STATUSES.includes(r.code_status) ? r.code_status : "idle",
  cwd: typeof r.cwd === "string" && r.cwd ? r.cwd : null,
  ephemeral: typeof r.id === "string" && r.id.startsWith("eph_"),
  kinds: kindsOf(r.id),
});
export const toMetrics = (r: any): Metrics => ({
  providerId: r.provider_id ?? null, providerKind: r.provider_kind ?? null, model: r.model ?? null,
  quantization: r.quantization ?? null, contextLength: r.context_length ?? null,
  promptTokens: r.prompt_tokens ?? 0, completionTokens: r.completion_tokens ?? 0, reasoningTokens: r.reasoning_tokens ?? 0,
  ttftMs: r.ttft_ms ?? null, totalMs: r.total_ms ?? null, prefillTps: r.prefill_tps ?? null, decodeTps: r.decode_tps ?? null,
  source: r.source === "backend" ? "backend" : "estimated", createdAt: r.created_at,
  ...(r.json_valid === null || r.json_valid === undefined ? {} : { jsonValid: !!r.json_valid, ...(r.json_error ? { jsonError: r.json_error } : {}) }),
});
/** Attachment metadata of one message in position order (deleted ones included). Empty on any error. */
export const attachmentMetasOf = (messageId: string): NonNullable<Message["attachments"]> => {
  try {
    return (db.prepare(
      "SELECT a.id, a.name, a.mime, a.kind, a.size, a.status FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = ? ORDER BY ma.position, a.created_at, a.id",
    ).all(messageId) as any[]).map((a) => ({ id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, status: a.status === "deleted" ? "deleted" : "ready" }));
  } catch { return []; }
};
export const toMessage = (r: any): Message => {
  const atts = r.role === "user" ? attachmentMetasOf(r.id) : [];
  const mr = r.role === "assistant" && r.status !== "streaming"
    ? db.prepare("SELECT * FROM metrics WHERE message_id = ?").get(r.id) : undefined;
  return {
    id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content,
    status: r.status, createdAt: r.created_at, seq: r.seq, parentId: r.parent_id ?? null,
    reasoning: typeof r.reasoning === "string" && r.reasoning ? r.reasoning : null,
    metrics: mr ? toMetrics(mr) : null,
    toolCalls: parseJsonArray(r.tool_calls), sources: parseJsonArray(r.sources), guardBlocked: parseJsonArray(r.guard_blocked),
    phases: parseJsonArray(r.phases), agents: parseJsonArray(r.agents),
    changes: (parseJsonArray(r.changes) as FileChange[] | null)?.map((c) => (typeof c.patch === "string" && c.patch.length > 20_000 ? { path: c.path, status: c.status, additions: c.additions, deletions: c.deletions } : c)) ?? null,
    ...(r.via === "voice" ? { via: "voice" as const } : {}),
    ...(atts.length ? { attachments: atts } : {}),
  };
};
export const toProvider = (r: any): Provider => ({
  id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, model: r.model,
  hasKey: !!r.api_key, deleted: !!r.deleted, seq: r.seq,
  effortProfile: typeof r.effort_profile === "string" && r.effort_profile ? r.effort_profile : null,
  shared: !!r.shared,
});

export const getConversationRow = (id: string): any => db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
export const getMessageRow = (id: string): any => db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
export const getProviderRow = (id: string): any => db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
export function insertMessage(
  userId: string,
  m: Omit<Message, "seq" | "parentId" | "reasoning" | "metrics" | "toolCalls" | "sources" | "phases" | "changes" | "agents"> & { parentId?: string | null; reasoning?: string | null },
): Message {
  const seq = nextSeq();
  const parentId = m.parentId ?? null;
  const reasoning = m.reasoning || null;
  db.prepare(
    "INSERT INTO messages (id, user_id, conversation_id, role, content, status, created_at, seq, parent_id, reasoning) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(m.id, userId, m.conversationId, m.role, m.content, m.status, m.createdAt, seq, parentId, reasoning);
  return toMessage(getMessageRow(m.id));
}

/** `reasoning`: undefined = leave unchanged. */
export function updateMessage(id: string, content: string, status: Message["status"], reasoning?: string | null): Message {
  if (reasoning === undefined) db.prepare("UPDATE messages SET content = ?, status = ?, seq = ? WHERE id = ?").run(content, status, nextSeq(), id);
  else db.prepare("UPDATE messages SET content = ?, status = ?, reasoning = ?, seq = ? WHERE id = ?").run(content, status, reasoning || null, nextSeq(), id);
  return toMessage(getMessageRow(id));
}

/** Persists the tool-call trace / search sources of a message (bumps seq so sync and upsert carry them). */
export function setMessageTools(id: string, toolCalls: ToolCall[] | null, sources: SearchSource[] | null): Message {
  db.prepare("UPDATE messages SET tool_calls = ?, sources = ?, seq = ? WHERE id = ?").run(
    toolCalls && toolCalls.length ? JSON.stringify(toolCalls) : null,
    sources && sources.length ? JSON.stringify(sources) : null, nextSeq(), id,
  );
  return toMessage(getMessageRow(id));
}

/** Persists the injection-guard notices of a message (bumps seq so sync and upsert carry them). */
export function setMessageGuard(id: string, notices: GuardNotice[]): Message {
  db.prepare("UPDATE messages SET guard_blocked = ?, seq = ? WHERE id = ?").run(notices.length ? JSON.stringify(notices) : null, nextSeq(), id);
  return toMessage(getMessageRow(id));
}

/** v4: persists phases / changes / agents of a message (undefined = leave unchanged; bumps seq so sync and upsert carry them). */
export function setMessageV4(id: string, v: { phases?: PhaseRecord[] | null; changes?: FileChange[] | null; agents?: AgentRecord[] | null }): Message {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [col, val] of [["phases", v.phases], ["changes", v.changes], ["agents", v.agents]] as const) {
    if (val === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(val && val.length ? JSON.stringify(val) : null);
  }
  if (sets.length) db.prepare(`UPDATE messages SET ${sets.join(", ")}, seq = ? WHERE id = ?`).run(...args, nextSeq(), id);
  return toMessage(getMessageRow(id));
}
