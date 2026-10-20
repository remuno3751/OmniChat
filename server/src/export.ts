import { randomUUID } from "node:crypto";
import { db, nextSeq, currentSeq, toConversation, toMessage, parseJson, attachmentMetasOf } from "./db.js";
import { AuthError } from "./auth.js";
import { pathRows, lastMessageId } from "./branching.js";
import { getSettings, toProject, toPreset } from "./projects.js";
import { sanitizeParams, sanitizeEffort } from "./sampling.js";
import { broadcast } from "./hub.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const IMPORT_LIMIT = 50 * 1024 * 1024;
const EXPORT_VERSION = 1;

const hasCol = (table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

// ---------- helpers ----------
/** Filename without path/control/non-portable characters; `ascii` is a latin-1 safe variant for the plain filename= parameter. */
export function safeBaseName(title: string, fallback = "conversation"): { utf8: string; ascii: string } {
  let s = String(title ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f"\\/:*?<>|;,%\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, "");
  s = [...s].slice(0, 60).join("").replace(/[.\s]+$/, "");
  if (!s) s = fallback;
  const ascii = s.replace(/[^\x20-\x7e]/g, "_").replace(/\s+/g, "_") || fallback;
  return { utf8: s, ascii };
}
export function contentDisposition(base: string, ext: string, fallback?: string): string {
  const n = safeBaseName(base, fallback);
  const star = encodeURIComponent(n.utf8 + "." + ext).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${n.ascii}.${ext}"; filename*=UTF-8''${star}`;
}
const sourcesOf = (r: any): any[] | null => {
  if (!("sources" in r)) return null;
  const v = typeof r.sources === "string" ? parseJson(r.sources) : r.sources;
  return Array.isArray(v) && v.length ? v : null;
};

function exportMessage(r: any, reasoning: boolean) {
  const m: any = {
    id: r.id, parentId: r.parent_id ?? null, role: r.role, content: r.content, status: r.status, createdAt: r.created_at,
    reasoning: reasoning && r.reasoning ? r.reasoning : null,
  };
  const src = sourcesOf(r);
  if (src) m.sources = src;
  // the list of attached files (name, kind, size); never their content. Import ignores this field.
  const atts = r.role === "user" ? attachmentMetasOf(r.id) : [];
  if (atts.length) m.attachments = atts.map((a) => ({ name: a.name, kind: a.kind, mime: a.mime, size: a.size, status: a.status }));
  return m;
}

function exportConversation(c: any, branches: "current" | "all", reasoning: boolean) {
  const headId = c.head_id ?? lastMessageId(c.id);
  const rows: any[] = branches === "current"
    ? pathRows(c.id, headId)
    : db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, seq").all(c.id);
  const cv = toConversation(c);
  return {
    id: cv.id, title: cv.title, providerId: cv.providerId, model: cv.model, createdAt: cv.createdAt, updatedAt: cv.updatedAt,
    projectId: cv.projectId, systemPrompt: cv.systemPrompt, systemMode: cv.systemMode, effort: cv.effort, params: cv.params,
    pinned: cv.pinned, pinnedAt: cv.pinnedAt,
    headId: rows.some((r) => r.id === headId) ? headId : (rows.length ? rows[rows.length - 1].id : null),
    messages: rows.map((r) => exportMessage(r, reasoning)),
  };
}

export function getOwnedConversation(userId: string, id: string): any {
  if (typeof id === "string" && id.startsWith("eph_")) throw new AuthError("Conversation not found", 404); // ephemeral chats are never exported
  const c = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
  if (!c || c.user_id !== userId || c.deleted) throw new AuthError("Conversation not found", 404);
  return c;
}

// ---------- single conversation ----------
function exportProject(p: any) {
  const x = toProject(p);
  return {
    id: x.id, name: x.name, systemPrompt: x.systemPrompt, systemMode: x.systemMode, defaultProviderId: x.defaultProviderId,
    defaultModel: x.defaultModel, effort: x.effort, params: x.params, createdAt: x.createdAt, updatedAt: x.updatedAt,
  };
}

export function conversationJson(userId: string, id: string, branches: "current" | "all", reasoning: boolean) {
  const c = getOwnedConversation(userId, id);
  const conv = exportConversation(c, branches, reasoning);
  const prow = c.project_id ? (db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ? AND deleted = 0").get(c.project_id, userId) as any) : null;
  return {
    version: EXPORT_VERSION, exportedAt: Date.now(),
    projects: prow ? [exportProject(prow)] : [], presets: [], conversations: [conv],
  };
}

export function conversationMarkdown(userId: string, id: string, branches: "current" | "all", reasoning: boolean): string {
  const c = getOwnedConversation(userId, id);
  const conv = exportConversation(c, branches, reasoning);
  const prow = c.project_id ? (db.prepare("SELECT name FROM projects WHERE id = ?").get(c.project_id) as any) : null;
  const out: string[] = [`# ${conv.title.replace(/\s+/g, " ")}`, ""];
  if (prow?.name) out.push(`- Project: ${prow.name}`);
  if (conv.model) out.push(`- Model: ${conv.model}`);
  out.push(`- Date: ${new Date(conv.createdAt).toISOString()}`, "");

  const render = (m: any, indent = "") => {
    const lines: string[] = [];
    lines.push(`**${m.role === "user" ? "You" : "Assistant"}:** ${m.content}`);
    if (Array.isArray(m.attachments) && m.attachments.length) {
      lines.push("", "Attachments:");
      for (const a of m.attachments) lines.push(`- ${String(a.name).replace(/\s+/g, " ")} (${a.kind}, ${a.size} bytes${a.status === "deleted" ? ", deleted" : ""})`);
    }
    if (reasoning && m.reasoning) {
      lines.push("", "> Thinking", ...String(m.reasoning).split("\n").map((l: string) => `> ${l}`));
    }
    if (Array.isArray(m.sources) && m.sources.length) {
      lines.push("", "Sources:");
      m.sources.forEach((s: any, i: number) => {
        if (s && typeof s === "object") lines.push(`${Number(s.index) || i + 1}. [${String(s.title ?? s.url ?? "")}](${String(s.url ?? "")})`);
      });
    }
    lines.push("");
    out.push(...(indent ? lines.map((l) => (l ? indent + l : l)) : lines));
  };

  if (branches === "current") {
    for (const m of conv.messages) render(m);
  } else {
    // depth-first tree walk: the first child continues the thread, further siblings are marked as alternative branches
    const kids = new Map<string | null, any[]>();
    const ids = new Set(conv.messages.map((m: any) => m.id));
    for (const m of conv.messages) {
      const p = m.parentId && ids.has(m.parentId) ? m.parentId : null;
      let l = kids.get(p);
      if (!l) kids.set(p, (l = []));
      l.push(m);
    }
    const stack: { m: any; depth: number; label: string }[] = [];
    const push = (p: string | null, depth: number) => {
      const list = kids.get(p) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        stack.push({ m: list[i], depth: depth + (i > 0 ? 1 : 0), label: list.length > 1 ? `Branch ${i + 1}/${list.length}` : "" });
      }
    };
    push(null, 0);
    const seen = new Set<string>();
    while (stack.length) {
      const { m, depth, label } = stack.pop()!;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const q = "> ".repeat(Math.min(depth, 6));
      if (label) out.push(`${q}*[${label}]*`, "");
      render(m, q);
      push(m.id, depth);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------- everything ----------
export function fullExport(userId: string) {
  const projects = (db.prepare("SELECT * FROM projects WHERE user_id = ? AND deleted = 0 ORDER BY created_at").all(userId) as any[]).map(exportProject);
  const presets = (db.prepare("SELECT * FROM prompt_presets WHERE user_id = ? AND deleted = 0 ORDER BY created_at").all(userId) as any[])
    .map(toPreset).map((p) => ({ id: p.id, name: p.name, text: p.text, createdAt: p.createdAt, updatedAt: p.updatedAt }));
  const providers = (db.prepare("SELECT id, name, kind, base_url, model, effort_profile FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY created_at").all(userId) as any[])
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.base_url, model: p.model, effortProfile: p.effort_profile ?? null }));
  const { seq: _seq, ...settings } = getSettings(userId);
  const convs = (db.prepare("SELECT * FROM conversations WHERE user_id = ? AND deleted = 0 ORDER BY created_at, seq").all(userId) as any[])
    .map((c) => exportConversation(c, "all", true));
  return { version: EXPORT_VERSION, exportedAt: Date.now(), projects, presets, providers, settings, conversations: convs };
}

// ---------- import ----------
const bad = (m: string) => new AuthError(`Invalid import: ${m}`, 400);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, what: string, max: number, required = false): string | null => {
  if (v === undefined || v === null) { if (required) throw bad(`${what} is required`); return null; }
  if (typeof v !== "string") throw bad(`${what} must be a string`);
  if (required && !v) throw bad(`${what} is required`);
  return v.length > max ? v.slice(0, max) : v;
};
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 8.64e15 ? Math.trunc(v) : fallback;
const arr = (v: unknown, what: string, max: number): any[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${what} must be an array`);
  if (v.length > max) throw bad(`${what} has too many entries`);
  return v;
};
const idOf = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v || v.length > 200) throw bad(`${what} must be a non-empty string id`);
  return v;
};
function cleanSources(v: unknown): string | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: any[] = [];
  for (const s of v.slice(0, 50)) {
    if (!isObj(s) || typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) continue;
    const e: any = {
      index: Number.isInteger(s.index) ? s.index : out.length + 1,
      title: typeof s.title === "string" ? s.title.slice(0, 500) : s.url.slice(0, 500), url: s.url.slice(0, 2000),
    };
    if (typeof s.snippet === "string") e.snippet = s.snippet.slice(0, 1000);
    out.push(e);
  }
  return out.length ? JSON.stringify(out) : null;
}

export interface ImportCounts { projects: number; presets: number; conversations: number; messages: number }

export function importData(userId: string, body: unknown): ImportCounts {
  if (!isObj(body)) throw bad("body must be a JSON object");
  if (body.version !== undefined && body.version !== EXPORT_VERSION) throw bad("unsupported version");
  const projectsIn = arr(body.projects, "projects", 10_000);
  const presetsIn = arr(body.presets, "presets", 10_000);
  const convsIn = arr(body.conversations, "conversations", 100_000);
  const now = Date.now();
  const ownsProvider = db.prepare("SELECT 1 FROM providers WHERE id = ? AND user_id = ? AND deleted = 0");
  const provOk = (v: unknown): string | null => (typeof v === "string" && v && v.length <= 200 && ownsProvider.get(v, userId) ? v : null);
  const effortOf = (v: unknown) => { const e = sanitizeEffort(v === undefined ? null : v); return e === undefined ? null : e; };
  const modeOf = (v: unknown) => (v === "replace" ? "replace" : "append");
  const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

  // ---- validate everything first (nothing is written when this throws) ----
  type P = { newId: string; name: string; systemPrompt: string | null; systemMode: string; prov: string | null; model: string | null; effort: string | null; params: any; createdAt: number; updatedAt: number };
  const projects: P[] = [];
  const projMap = new Map<string, string>();
  for (const p of projectsIn) {
    if (!isObj(p)) throw bad("project must be an object");
    const oldId = idOf(p.id, "project.id");
    if (projMap.has(oldId)) continue;
    const newId = randomUUID();
    projMap.set(oldId, newId);
    const createdAt = num(p.createdAt, now);
    projects.push({
      newId, name: str(p.name, "project.name", 200, true)!, systemPrompt: str(p.systemPrompt, "project.systemPrompt", 200_000),
      systemMode: modeOf(p.systemMode), prov: provOk(p.defaultProviderId), model: str(p.defaultModel, "project.defaultModel", 300) || null,
      effort: effortOf(p.effort), params: sanitizeParams(p.params), createdAt, updatedAt: num(p.updatedAt, createdAt),
    });
  }
  const presets = presetsIn.map((p) => {
    if (!isObj(p)) throw bad("preset must be an object");
    const createdAt = num(p.createdAt, now);
    return { newId: randomUUID(), name: str(p.name, "preset.name", 200, true)!, text: str(p.text, "preset.text", 200_000) ?? "", createdAt, updatedAt: num(p.updatedAt, createdAt) };
  });

  type M = { newId: string; parent: string | null; role: string; content: string; status: string; createdAt: number; reasoning: string | null; sources: string | null };
  type C = { newId: string; title: string; prov: string | null; model: string | null; createdAt: number; updatedAt: number; projectId: string | null; systemPrompt: string | null; systemMode: string; effort: string | null; params: any; head: string | null; msgs: M[]; pinned: boolean; pinnedAt: number | null };
  const convs: C[] = [];
  const seenConv = new Set<string>();
  let msgTotal = 0;
  for (const c of convsIn) {
    if (!isObj(c)) throw bad("conversation must be an object");
    const oldId = idOf(c.id, "conversation.id");
    if (seenConv.has(oldId)) throw bad("duplicate conversation id");
    seenConv.add(oldId);
    const raw = arr(c.messages, "conversation.messages", 200_000);
    msgTotal += raw.length;
    if (msgTotal > 1_000_000) throw bad("too many messages");
    const idMap = new Map<string, string>();
    const parentOld = new Map<string, string | null>();
    for (const m of raw) {
      if (!isObj(m)) throw bad("message must be an object");
      const mid = idOf(m.id, "message.id");
      if (idMap.has(mid)) throw bad("duplicate message id");
      idMap.set(mid, randomUUID());
      parentOld.set(mid, m.parentId === null || m.parentId === undefined ? null : idOf(m.parentId, "message.parentId"));
    }
    // cycles in the parent graph are rejected; dangling parents become roots
    for (const start of parentOld.keys()) {
      const seen = new Set<string>();
      let cur: string | null | undefined = start;
      while (cur && parentOld.has(cur)) {
        if (seen.has(cur)) throw bad("message parent cycle");
        seen.add(cur);
        cur = parentOld.get(cur);
      }
    }
    const msgs: M[] = raw.map((m) => {
      if (m.role !== "user" && m.role !== "assistant") throw bad("message.role must be user or assistant");
      if (typeof m.content !== "string") throw bad("message.content must be a string");
      const p = parentOld.get(m.id) ?? null;
      return {
        newId: idMap.get(m.id)!, parent: p && idMap.has(p) ? idMap.get(p)! : null, role: m.role, content: m.content,
        status: m.status === "error" || m.status === "stopped" ? m.status : "done", createdAt: num(m.createdAt, now),
        reasoning: str(m.reasoning, "message.reasoning", 5_000_000) || null, sources: cleanSources(m.sources),
      };
    });
    let head: string | null = null;
    if (typeof c.headId === "string" && idMap.has(c.headId)) head = idMap.get(c.headId)!;
    else if (msgs.length) head = [...msgs].sort((a, b) => a.createdAt - b.createdAt)[msgs.length - 1].newId;
    const createdAt = num(c.createdAt, now);
    const pid = typeof c.projectId === "string" ? projMap.get(c.projectId) ?? null : null;
    convs.push({
      newId: randomUUID(), title: str(c.title, "conversation.title", 500) || "Imported chat", prov: provOk(c.providerId),
      model: str(c.model, "conversation.model", 300) || null, createdAt, updatedAt: num(c.updatedAt, createdAt), projectId: pid,
      systemPrompt: str(c.systemPrompt, "conversation.systemPrompt", 200_000), systemMode: modeOf(c.systemMode),
      effort: effortOf(c.effort), params: sanitizeParams(c.params), head, msgs,
      pinned: c.pinned === true, pinnedAt: typeof c.pinnedAt === "number" && Number.isFinite(c.pinnedAt) ? c.pinnedAt : null,
    });
  }

  // ---- write (single transaction, new ids, fresh seq values) ----
  const startSeq = currentSeq();
  const srcCol = hasCol("messages", "sources");
  const insProject = db.prepare(
    "INSERT INTO projects (id, user_id, name, system_prompt, system_mode, default_provider_id, default_model, effort, params, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)",
  );
  const insPreset = db.prepare("INSERT INTO prompt_presets (id, user_id, name, text, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,0,?)");
  const insConv = db.prepare(
    "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, project_id, system_prompt, system_mode, effort, params, head_id, pinned, pinned_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)",
  );
  const insMsg = db.prepare(
    `INSERT INTO messages (id, user_id, conversation_id, role, content, status, created_at, seq, parent_id, reasoning${srcCol ? ", sources" : ""}) VALUES (?,?,?,?,?,?,?,?,?,?${srcCol ? ",?" : ""})`,
  );
  let messages = 0;
  db.exec("BEGIN");
  try {
    for (const p of projects) insProject.run(p.newId, userId, p.name, p.systemPrompt, p.systemMode, p.prov, p.model, p.effort, json(p.params), p.createdAt, p.updatedAt, nextSeq());
    for (const p of presets) insPreset.run(p.newId, userId, p.name, p.text, p.createdAt, p.updatedAt, nextSeq());
    for (const c of convs) {
      insConv.run(c.newId, userId, c.title, c.prov, c.model, c.createdAt, c.updatedAt, nextSeq(), c.projectId, c.systemPrompt, c.systemMode, c.effort, json(c.params), c.head, c.pinned ? 1 : 0, c.pinnedAt);
      for (const m of c.msgs) {
        const args: any[] = [m.newId, userId, c.newId, m.role, m.content, m.status, m.createdAt, nextSeq(), m.parent, m.reasoning];
        if (srcCol) args.push(m.sources);
        insMsg.run(...args);
        messages++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // ---- notify the user's devices (chunked upserts of the created rows) ----
  try {
    const rows = (t: string) => db.prepare(`SELECT * FROM ${t} WHERE user_id = ? AND seq > ? ORDER BY seq`).all(userId, startSeq) as any[];
    if (projects.length || presets.length) broadcast(userId, { type: "upsert", projects: rows("projects").map(toProject), presets: rows("prompt_presets").map(toPreset) });
    const cs = rows("conversations").map(toConversation);
    for (let i = 0; i < cs.length; i += 200) broadcast(userId, { type: "upsert", conversations: cs.slice(i, i + 200) });
    const ms = rows("messages");
    for (let i = 0; i < ms.length; i += 300) broadcast(userId, { type: "upsert", messages: ms.slice(i, i + 300).map(toMessage) });
  } catch { /* clients catch up via /sync */ }
  return { projects: projects.length, presets: presets.length, conversations: convs.length, messages };
}
