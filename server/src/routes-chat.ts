import { isAgentBridgeKind } from "./agent-kinds.js";
import { getUsableProviderRow } from "./shared-providers.js";
import type { FastifyInstance } from "fastify";
import { forbiddenOutboundUrl } from "./url-guard.js";
import { db, nextSeq, toConversation, getConversationRow, getMessageRow, getProviderRow } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { broadcast } from "./hub.js";
import { toProject, toPreset, getProjectRow, getPresetRow, getSettings, saveSettings, CONTEXT_OVERFLOW, sanitizeContextLimits, sanitizeModelParams, sanitizeModelVision, intIn, COMPRESS_AT_RANGE, COMPRESS_TARGET_RANGE, DEFAULT_CONTEXT_RANGE, TITLE_EVERY_RANGE } from "./projects.js";
import { SEARCH_MODES, TOOL_NAME_RE } from "./tools/types.js";
import { GUARD_LEVELS, SEARCH_SITES_RANGE, SEARCH_CALLS_RANGE, SEARCH_IMAGES_RANGE } from "./search/options.js";
import { sanitizeParams, sanitizeEffort } from "./sampling.js";
import { messageBelongs } from "./branching.js";
import { loadDebug } from "./debuglog.js";
import { loadEffortMap } from "./effort.js";
import { sanitizeResponseFormat, paramsProblem } from "./structured.js";
import { isEphemeralId, runEphemeral, registerEphemeral, getEphemeral, touchEphemeral, destroyEphemeral } from "./ephemeral.js";

const isStr = (v: unknown): v is string => typeof v === "string";
const bad = (msg: string) => new AuthError(msg, 400);
/** A 400 that also carries a machine-readable `code` (the error handler in index.ts adds it to the body). */
class CodedError extends AuthError { constructor(message: string, public code: string) { super(message, 400); } }
const has = (b: any, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const MAX_PROMPT = 200_000;

function modeOf(v: unknown): "append" | "replace" {
  if (v === "append" || v === "replace") return v;
  throw bad("systemMode must be 'append' or 'replace'");
}
function effortOf(v: unknown) {
  const e = sanitizeEffort(v);
  if (e === undefined) throw bad("effort must be low, medium, high, max or null");
  return e;
}
function promptOf(v: unknown): string | null {
  if (v === null) return null;
  if (!isStr(v)) throw bad("systemPrompt must be a string or null");
  return v.slice(0, MAX_PROMPT);
}
function paramsOf(v: unknown) {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw bad("params must be an object or null");
  const problem = paramsProblem(v);
  if (problem) throw bad(problem);
  return sanitizeParams(v);
}
function toolsOf(v: unknown): string[] | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 100 || v.some((x) => typeof x !== "string" || !TOOL_NAME_RE.test(x))) {
    throw bad("tools must be null or an array of tool names ([a-z0-9_]{1,40})");
  }
  return [...new Set(v as string[])];
}
function searchModeOf(v: unknown) {
  if (v === null) return null;
  if (v === "auto") return "smart"; // older clients
  if (typeof v === "string" && (SEARCH_MODES as readonly string[]).includes(v)) return v;
  throw bad("searchMode must be off, smart, always or null");
}
function chatModeOf(v: unknown): "chat" | "code" {
  if (v === "chat" || v === "code") return v;
  throw bad("mode must be chat or code");
}
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** The user's default provider as a send would resolve it (first live provider), for ephemeral creation checks. */
const defaultProviderId = (userId: string): string | undefined =>
  (db.prepare("SELECT id FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY created_at, seq LIMIT 1").get(userId) as { id?: string } | undefined)?.id;

export function registerChatRoutes(app: FastifyInstance): void {
  loadEffortMap(); // creates effort-map.json with defaults when missing
  // ---- conversations (create / update incl. v3 fields) ----
  app.put("/conversations/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    if (!isEphemeralId(id)) {
      if (b.ephemeral === true) throw bad("ephemeral chat ids must start with eph_");
      return putConversation(userId, id, b);
    }

    // ephemeral chat (docs/EPHEMERAL.md, PROTOCOL v7)
    const existing = getEphemeral(id);
    if (existing && existing.userId !== userId) throw new AuthError("Forbidden", 403);
    if (!existing && b.ephemeral !== true) throw new AuthError("Ephemeral chat no longer exists", 410);
    if (!existing && b.projectId !== undefined && b.projectId !== null) throw bad("ephemeral chats cannot belong to a project");
    // provider: the explicit one, or on creation without one the user's default (what a send would resolve to)
    const pid = isStr(b.providerId) && b.providerId ? b.providerId : !existing ? defaultProviderId(userId) : undefined;
    const pkind = pid ? getUsableProviderRow(userId, pid)?.kind : undefined;
    if (pid && isAgentBridgeKind(pkind)) throw bad(`Ephemeral chats do not support ${pkind} providers`);
    if (!existing) registerEphemeral(userId, authFromRequest(req).deviceId, id);
    const created = !existing;
    const nb: any = { ...b, title: "Ephemeral chat", pinned: false, mode: "chat", projectId: null };
    delete nb.ephemeral;
    touchEphemeral(id);
    try {
      return runEphemeral(() => putConversation(userId, id, nb));
    } catch (e) {
      if (created) destroyEphemeral(id, "ended");
      throw e;
    }
  });

  function putConversation(userId: string, id: string, b: any) {
    const row = getConversationRow(id);
    if (row && row.user_id !== userId) throw new AuthError("Forbidden", 403);

    // Validate before writing anything.
    let projectId: string | null | undefined;
    if (has(b, "projectId")) {
      if (b.projectId === null) projectId = null;
      else if (isStr(b.projectId)) {
        const p = getProjectRow(b.projectId);
        if (!p || p.user_id !== userId || p.deleted) throw bad("Unknown project");
        projectId = b.projectId;
      } else throw bad("projectId must be a string or null");
    }
    const systemPrompt = has(b, "systemPrompt") ? promptOf(b.systemPrompt) : undefined;
    const systemMode = has(b, "systemMode") ? modeOf(b.systemMode) : undefined;
    const effort = has(b, "effort") ? effortOf(b.effort) : undefined;
    const params = has(b, "params") ? paramsOf(b.params) : undefined;
    const tools = has(b, "tools") ? toolsOf(b.tools) : undefined;
    const searchMode = has(b, "searchMode") ? searchModeOf(b.searchMode) : undefined;
    let ctxOverflow: string | null | undefined;
    if (has(b, "contextOverflow")) {
      if (b.contextOverflow !== null && !CONTEXT_OVERFLOW.includes(b.contextOverflow)) throw bad("contextOverflow must be truncate, summarize, stop or null");
      ctxOverflow = b.contextOverflow;
    }
    const convMode = has(b, "mode") ? chatModeOf(b.mode) : undefined;
    // VS Code bridge approval mode: only for Code conversations; "full" needs an explicit confirmation. Never reset by the server.
    let approvalMode: "manual" | "auto" | "full" | undefined;
    if (has(b, "approvalMode")) {
      if (b.approvalMode !== "manual" && b.approvalMode !== "auto" && b.approvalMode !== "full") throw bad("approvalMode must be manual, auto or full");
      if (b.approvalMode === "full" && b.confirmFull !== true) throw new CodedError("approvalMode full needs confirmFull: true", "confirm_required");
      approvalMode = b.approvalMode;
      const effMode = convMode ?? row?.mode;
      if (row && effMode !== "code") throw bad("approvalMode is only for Code conversations");
    }
    let responseFormat: unknown;
    if (has(b, "responseFormat")) {
      responseFormat = sanitizeResponseFormat(b.responseFormat);
      if (responseFormat === undefined) throw bad("responseFormat must be null, {type:'json_object'} or {type:'json_schema', schema:{...}}");
    }
    if (has(b, "pinned") && typeof b.pinned !== "boolean") throw bad("pinned must be a boolean");
    const pinned: boolean | undefined = has(b, "pinned") ? b.pinned : undefined;
    let headId: string | null | undefined;
    if (has(b, "headId")) {
      if (b.headId === null) headId = null;
      else if (isStr(b.headId)) {
        if (!row || !messageBelongs(id, b.headId)) throw bad("headId must be a message of this conversation");
        headId = b.headId;
      } else throw bad("headId must be a string or null");
    }

    const now = Date.now();
    const seq = nextSeq();
    if (!row) {
      let providerId = isStr(b.providerId) && b.providerId ? b.providerId : null;
      let model = isStr(b.model) && b.model ? b.model : null;
      if (projectId) {
        const p = getProjectRow(projectId);
        if (!providerId && !model) { providerId = p.default_provider_id ?? null; model = p.default_model ?? null; }
        else if (!providerId && model === null) providerId = p.default_provider_id ?? null;
      }
      const pin = pinned === true;
      // Mode: explicit, else 'code' when the resolved provider is a dsh bridge (providerId, else the project default), else 'chat'.
      const resolvedProviderId = providerId ?? (projectId ? getProjectRow(projectId)?.default_provider_id ?? null : null);
      const insertMode = convMode ?? (resolvedProviderId && isAgentBridgeKind(getUsableProviderRow(userId, resolvedProviderId)?.kind) ? "code" : "chat");
      if (approvalMode !== undefined && insertMode !== "code") throw bad("approvalMode is only for Code conversations");
      db.prepare(
        "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, project_id, system_prompt, system_mode, effort, params, head_id, tools, search_mode, response_format, pinned, pinned_at, mode, context_overflow) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id, userId, isStr(b.title) && b.title ? b.title : "New chat", providerId, model, now, now, seq,
        projectId ?? null, systemPrompt ?? null, systemMode ?? "append", effort ?? null, json(params), headId ?? null,
        json(tools), searchMode ?? null, json(responseFormat), pin ? 1 : 0, pin ? now : null, insertMode, ctxOverflow ?? null,
      );
    } else {
      const title = isStr(b.title) && b.title ? b.title : row.title;
      const providerId = has(b, "providerId") ? (isStr(b.providerId) ? b.providerId : null) : row.provider_id;
      const model = has(b, "model") ? (isStr(b.model) ? b.model : null) : row.model;
      const onlyHead = Object.keys(b).every((k) => k === "headId" || k === "pinned");
      // Pinning stamps pinnedAt once; re-pinning an already pinned chat keeps its place in the list.
      const pinnedNow = pinned !== undefined ? pinned : !!row.pinned;
      const pinnedAt = !pinnedNow ? null : pinned === true && !row.pinned ? now : row.pinned_at ?? now;
      db.prepare(
        "UPDATE conversations SET title = ?, provider_id = ?, model = ?, project_id = ?, system_prompt = ?, system_mode = ?, effort = ?, params = ?, head_id = ?, tools = ?, search_mode = ?, response_format = ?, pinned = ?, pinned_at = ?, mode = ?, context_overflow = ?, updated_at = ?, deleted = 0, seq = ? WHERE id = ?",
      ).run(
        title, providerId, model,
        projectId !== undefined ? projectId : row.project_id ?? null,
        systemPrompt !== undefined ? systemPrompt : row.system_prompt ?? null,
        systemMode ?? row.system_mode ?? "append",
        effort !== undefined ? effort : row.effort ?? null,
        params !== undefined ? json(params) : row.params ?? null,
        headId !== undefined ? headId : row.head_id ?? null,
        tools !== undefined ? json(tools) : row.tools ?? null,
        searchMode !== undefined ? searchMode : row.search_mode ?? null,
        responseFormat !== undefined ? json(responseFormat) : row.response_format ?? null,
        pinnedNow ? 1 : 0, pinnedAt,
        convMode ?? row.mode ?? "chat",
        ctxOverflow !== undefined ? ctxOverflow : row.context_overflow ?? null,
        onlyHead ? row.updated_at : now, seq, id,
      );
    }
    if (approvalMode !== undefined) db.prepare("UPDATE conversations SET approval_mode = ? WHERE id = ?").run(approvalMode === "manual" ? null : approvalMode, id);
    const conv = { ...toConversation(getConversationRow(id)), ...(isEphemeralId(id) ? { ephemeral: true } : {}) };
    broadcast(userId, { type: "upsert", conversations: [conv] });
    return conv;
  }

  // ---- projects ----
  app.put("/projects/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    const row = getProjectRow(id);
    if (row && row.user_id !== userId) throw new AuthError("Forbidden", 403);

    const name = has(b, "name") ? (isStr(b.name) && b.name.trim() ? b.name.trim().slice(0, 200) : undefined) : undefined;
    const systemPrompt = has(b, "systemPrompt") ? promptOf(b.systemPrompt) : undefined;
    const systemMode = has(b, "systemMode") ? modeOf(b.systemMode) : undefined;
    const effort = has(b, "effort") ? effortOf(b.effort) : undefined;
    const params = has(b, "params") ? paramsOf(b.params) : undefined;
    const tools = has(b, "tools") ? toolsOf(b.tools) : undefined;
    const searchMode = has(b, "searchMode") ? searchModeOf(b.searchMode) : undefined;
    const projMode = has(b, "mode") ? chatModeOf(b.mode) : undefined;
    const optStr = (k: string) => {
      if (!has(b, k)) return undefined;
      if (b[k] === null) return null;
      if (!isStr(b[k])) throw bad(`${k} must be a string or null`);
      return b[k] || null;
    };
    const defaultProviderId = optStr("defaultProviderId");
    const defaultModel = optStr("defaultModel");
    const now = Date.now();
    const seq = nextSeq();
    if (!row) {
      db.prepare(
        "INSERT INTO projects (id, user_id, name, system_prompt, system_mode, default_provider_id, default_model, effort, params, created_at, updated_at, deleted, seq, tools, search_mode, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)",
      ).run(id, userId, name ?? "New project", systemPrompt ?? null, systemMode ?? "append", defaultProviderId ?? null, defaultModel ?? null, effort ?? null, json(params), now, now, seq, json(tools), searchMode ?? null, projMode ?? "chat");
    } else {
      db.prepare(
        "UPDATE projects SET name = ?, system_prompt = ?, system_mode = ?, default_provider_id = ?, default_model = ?, effort = ?, params = ?, tools = ?, search_mode = ?, mode = ?, updated_at = ?, deleted = 0, seq = ? WHERE id = ?",
      ).run(
        name ?? row.name,
        systemPrompt !== undefined ? systemPrompt : row.system_prompt ?? null,
        systemMode ?? row.system_mode ?? "append",
        defaultProviderId !== undefined ? defaultProviderId : row.default_provider_id ?? null,
        defaultModel !== undefined ? defaultModel : row.default_model ?? null,
        effort !== undefined ? effort : row.effort ?? null,
        params !== undefined ? json(params) : row.params ?? null,
        tools !== undefined ? json(tools) : row.tools ?? null,
        searchMode !== undefined ? searchMode : row.search_mode ?? null,
        projMode ?? row.mode ?? "chat",
        now, seq, id,
      );
    }
    const p = toProject(getProjectRow(id));
    broadcast(userId, { type: "upsert", projects: [p] });
    return p;
  });

  app.delete("/projects/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const row = getProjectRow(id);
    if (!row || row.user_id !== userId) throw new AuthError("Project not found", 404);
    const convIds = (db.prepare("SELECT id FROM conversations WHERE user_id = ? AND project_id = ?").all(userId, id) as { id: string }[]).map((r) => r.id);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE projects SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), id);
      const mv = db.prepare("UPDATE conversations SET project_id = NULL, seq = ? WHERE id = ?");
      for (const cid of convIds) mv.run(nextSeq(), cid);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const p = toProject(getProjectRow(id));
    const conversations = convIds.map((cid) => toConversation(getConversationRow(cid)));
    broadcast(userId, { type: "upsert", projects: [p], ...(conversations.length ? { conversations } : {}) });
    return p;
  });

  // ---- prompt presets ----
  app.put("/presets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as any;
    const row = getPresetRow(id);
    if (row && row.user_id !== userId) throw new AuthError("Forbidden", 403);
    const name = isStr(b.name) && b.name.trim() ? b.name.trim().slice(0, 200) : undefined;
    const text = isStr(b.text) ? b.text.slice(0, MAX_PROMPT) : undefined;
    const now = Date.now();
    if (!row) {
      db.prepare("INSERT INTO prompt_presets (id, user_id, name, text, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,0,?)")
        .run(id, userId, name ?? "New preset", text ?? "", now, now, nextSeq());
    } else {
      db.prepare("UPDATE prompt_presets SET name = ?, text = ?, updated_at = ?, deleted = 0, seq = ? WHERE id = ?")
        .run(name ?? row.name, text ?? row.text, now, nextSeq(), id);
    }
    const p = toPreset(getPresetRow(id));
    broadcast(userId, { type: "upsert", presets: [p] });
    return p;
  });

  app.delete("/presets/:id", async (req) => {
    const userId = authFromRequest(req).userId;
    const id = (req.params as any).id as string;
    const row = getPresetRow(id);
    if (!row || row.user_id !== userId) throw new AuthError("Preset not found", 404);
    db.prepare("UPDATE prompt_presets SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?").run(Date.now(), nextSeq(), id);
    const p = toPreset(getPresetRow(id));
    broadcast(userId, { type: "upsert", presets: [p] });
    return p;
  });

  // ---- settings ----
  app.get("/settings", async (req) => getSettings(authFromRequest(req).userId));
  app.put("/settings", async (req) => {
    const userId = authFromRequest(req).userId;
    const b = (req.body ?? {}) as any;
    const patch: Record<string, unknown> = {};
    if (has(b, "systemPrompt")) patch.systemPrompt = promptOf(b.systemPrompt) || null;
    if (has(b, "effort")) patch.effort = effortOf(b.effort);
    if (has(b, "params")) patch.params = paramsOf(b.params);
    if (has(b, "devMode")) patch.devMode = !!b.devMode;
    if (has(b, "tools")) patch.tools = toolsOf(b.tools);
    if (has(b, "searchMode")) {
      const sm = b.searchMode === "auto" ? "smart" : b.searchMode; // older clients
      if (typeof sm !== "string" || !(SEARCH_MODES as readonly string[]).includes(sm)) throw bad("searchMode must be off, smart or always");
      patch.searchMode = sm;
    }
    if (has(b, "search")) {
      if (!b.search || typeof b.search !== "object" || Array.isArray(b.search)) throw bad("search must be an object");
      const s = b.search as Record<string, unknown>;
      const chk = (k: string, r: [number, number]) => { if (has(s, k) && !intIn(s[k], r)) throw bad(`search.${k} must be an integer ${r[0]}..${r[1]}`); };
      chk("maxSites", SEARCH_SITES_RANGE); chk("maxSearches", SEARCH_CALLS_RANGE); chk("maxImages", SEARCH_IMAGES_RANGE);
      for (const k of ["allowDomains", "denyDomains"]) if (has(s, k) && (!Array.isArray(s[k]) || (s[k] as unknown[]).length > 200)) throw bad(`search.${k} must be an array of up to 200 domains`);
      if (has(s, "searchModel") && s.searchModel !== null && !(isStr(s.searchModel) && s.searchModel.includes("::") && s.searchModel.length <= 600)) throw bad("search.searchModel must be '<providerId>::<model>' or null");
      if (has(s, "guard") && !(GUARD_LEVELS as readonly unknown[]).includes(s.guard)) throw bad("search.guard must be off, standard or strict");
      if (has(s, "visionModel") && s.visionModel !== "answer" && s.visionModel !== "search") throw bad("search.visionModel must be answer or search");
      for (const k of ["readPages", "readImages", "allowPrivateUrls"]) if (has(s, k) && typeof s[k] !== "boolean") throw bad(`search.${k} must be a boolean`);
      patch.search = s;
    }
    if (has(b, "autoTitle")) {
      if (typeof b.autoTitle !== "boolean") throw bad("autoTitle must be a boolean");
      patch.autoTitle = b.autoTitle;
    }
    if (has(b, "titleModel")) {
      if (b.titleModel !== null && (!isStr(b.titleModel) || b.titleModel.length > 600)) throw bad("titleModel must be '<providerId>::<model>' or null");
      patch.titleModel = b.titleModel || null;
    }
    if (has(b, "titleEvery")) {
      if (!intIn(b.titleEvery, TITLE_EVERY_RANGE)) throw bad("titleEvery must be an integer 0..50");
      patch.titleEvery = b.titleEvery;
    }
    if (has(b, "modelParams")) {
      const v = b.modelParams;
      if (v !== null) {
        if (typeof v !== "object" || Array.isArray(v)) throw bad("modelParams must be an object or null");
        const ents = Object.entries(v as Record<string, unknown>);
        if (ents.length > 500) throw bad("modelParams has too many entries");
        for (const [k, x] of ents) {
          if (!k || k.length > 600) throw bad("modelParams keys must be '<providerId>::<model>'");
          if (x !== null && (typeof x !== "object" || Array.isArray(x))) throw bad("modelParams values must be SamplingParams objects");
        }
      }
      patch.modelParams = sanitizeModelParams(v);
    }
    if (has(b, "contextOverflow")) {
      if (!CONTEXT_OVERFLOW.includes(b.contextOverflow)) throw bad("contextOverflow must be truncate, summarize or stop");
      patch.contextOverflow = b.contextOverflow;
    }
    if (has(b, "contextLimits")) {
      const v = b.contextLimits;
      if (v !== null) {
        if (typeof v !== "object" || Array.isArray(v)) throw bad("contextLimits must be an object or null");
        const ents = Object.entries(v as Record<string, unknown>);
        if (ents.length > 500) throw bad("contextLimits has too many entries");
        for (const [k, x] of ents) {
          if (!k || k.length > 600) throw bad("contextLimits keys must be '<providerId>::<model>'");
          if (typeof x !== "number" || !Number.isInteger(x) || x <= 0 || x > 100_000_000) throw bad("contextLimits values must be positive integers");
        }
      }
      patch.contextLimits = sanitizeContextLimits(v);
    }
    if (has(b, "contextCompressAt")) {
      if (b.contextCompressAt !== null && !intIn(b.contextCompressAt, COMPRESS_AT_RANGE)) throw bad("contextCompressAt must be an integer 50..95 or null");
      patch.contextCompressAt = b.contextCompressAt;
    }
    if (has(b, "contextCompressTarget")) {
      if (!intIn(b.contextCompressTarget, COMPRESS_TARGET_RANGE)) throw bad("contextCompressTarget must be an integer 20..80");
      patch.contextCompressTarget = b.contextCompressTarget;
    }
    if (has(b, "defaultContextLength")) {
      if (b.defaultContextLength !== null && !intIn(b.defaultContextLength, DEFAULT_CONTEXT_RANGE)) throw bad("defaultContextLength must be an integer 256..10000000 or null");
      patch.defaultContextLength = b.defaultContextLength;
    }
    if (has(b, "notify")) {
      const v = b.notify;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad("notify must be an object of booleans");
      for (const k of ["done", "approval", "error"]) {
        if (has(v, k) && typeof v[k] !== "boolean") throw bad("notify must be an object of booleans");
      }
      patch.notify = { done: v.done !== false, approval: v.approval !== false, error: v.error !== false };
    }
    if (has(b, "notifyUrl")) {
      const v = b.notifyUrl;
      if (v === null || v === "") patch.notifyUrl = null;
      else {
        if (!isStr(v) || v.length > 500) throw bad("notifyUrl must be an http(s) URL of at most 500 characters or null");
        let protocol = "";
        try { protocol = new URL(v).protocol; } catch { /* invalid URL */ }
        if (protocol !== "http:" && protocol !== "https:") throw bad("notifyUrl must be an http(s) URL of at most 500 characters or null");
        if (forbiddenOutboundUrl(v)) throw bad("notifyUrl must not point at a link-local or metadata address");
        patch.notifyUrl = v;
      }
    }
    if (has(b, "ephemeralIdleMinutes")) {
      const v = b.ephemeralIdleMinutes;
      if (!Number.isInteger(v) || v < 1 || v > 1440) throw bad("ephemeralIdleMinutes must be an integer 1..1440");
      patch.ephemeralIdleMinutes = v;
    }
    if (has(b, "modelVision")) {
      const v = b.modelVision;
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) throw bad("modelVision must be an object of booleans or null");
      patch.modelVision = sanitizeModelVision(v);
    }
    if (has(b, "activePetId")) {
      const v = b.activePetId;
      if (v !== null && (!isStr(v) || v.length > 100)) throw bad("activePetId must be a string of at most 100 characters or null");
      patch.activePetId = v || null;
    }
    const s = saveSettings(userId, patch as any);
    broadcast(userId, { type: "upsert", settings: s });
    return s;
  });

  // ---- debug ----
  app.get("/messages/:id/debug", async (req) => {
    const userId = authFromRequest(req).userId;
    const row = getMessageRow((req.params as any).id);
    if (!row || row.user_id !== userId) throw new AuthError("No debug info", 404);
    const rec = loadDebug(row.id);
    if (!rec) throw new AuthError("No debug info", 404);
    return rec;
  });
}
