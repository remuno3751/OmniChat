import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";
import { deviceFromToken } from "./auth.js";
import { isAdminUser } from "./shared-providers.js";
import { ariaFetch, ariaFetchBinary, ariaFailure, ariaOk, safeMessage, VoiceError, type AriaCall, type AriaResult } from "./voice-aria.js";
import {
  readVoiceConfig, updateVoiceConfig, getPrefs, saveOwnPrefs, effectivePrefs,
  addVoiceModel, getVoiceModel, listVoiceModels, removeVoiceModel, readUserDailyMinutes, setVoiceQuota, type VoiceKind,
} from "./voice-store.js";
import {
  emptyVoiceUsage, voiceUsageByUser, voiceUsageDays, voiceUsageToday, voiceQuotaMinutes, voiceQuotaExceeded,
} from "./voice-usage.js";

// Voice call REST API (docs/design/ARIA-HOST.md, "OmniChat サーバーの API"). Everything here talks to Aria through voice-aria.ts,
// so the Aria URL and tokens never reach a response, an error or a log line.

const UPLOAD_LIMIT = 300 * 1024 * 1024;
const SAFE_NAME = /^(?!\.)[^\/\\\x00-\x1f\x7f:*?"<>|]{1,200}$/;
const TTS_PREVIEW_DEFAULT = "こんにちは。この声で話します。";
const BUILTIN_VOICE = "tsukuyomi";

/** A plain refusal (401 / 403 / 404 / 415), in the same {error} shape as VoiceError. */
class Deny extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Maps our errors to `{error, code?}`. VoiceError -> its status; RangeError (bad input from the body) -> 400; anything else goes to the global handler. */
function fail(reply: FastifyReply, e: unknown): unknown {
  if (e instanceof VoiceError) { reply.code(e.status); return { error: e.message, code: e.code, ...e.extra }; }
  if (e instanceof Deny) { reply.code(e.status); return e.code ? { error: e.message, code: e.code } : { error: e.message }; }
  if (e instanceof RangeError) { reply.code(400); return { error: e.message }; }
  throw e;
}

const guard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try { return await fn(req, reply); } catch (e) { return fail(reply, e); }
  };

/** The device token's user. 401 when there is none. */
function caller(req: FastifyRequest): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  const u = deviceFromToken(m?.[1]?.trim());
  if (!u) throw new Deny(401, "Unauthorized");
  return u.userId;
}

/** The device token's user, who must be an administrator. 403 otherwise. */
function admin(req: FastifyRequest): string {
  const id = caller(req);
  if (!isAdminUser(id)) throw new Deny(403, "Forbidden");
  return id;
}

const uuidOf = (m: unknown): string | null => {
  const o = obj(m);
  return isText(o.uuid) ? o.uuid : isText(o.id) ? o.id : null;
};

/** Aria's model list: a bare array, or an object with `models` / `voices`. The other fields of an object answer are kept. */
function splitModels(raw: unknown): { rest: Record<string, unknown>; list: unknown[] } {
  if (Array.isArray(raw)) return { rest: {}, list: raw };
  const o = obj(raw);
  const key = Array.isArray(o.models) ? "models" : Array.isArray(o.voices) ? "voices" : null;
  if (!key) return { rest: o, list: [] };
  const { [key]: list, ...rest } = o;
  return { rest, list };
}

/** Aria's list at `path` as uuid -> item. null when Aria cannot be asked (best effort callers). */
async function ariaModelMap(path: string): Promise<Map<string, Record<string, any>> | null> {
  try {
    const m = new Map<string, Record<string, any>>();
    for (const x of splitModels(await ariaOk(path, { admin: true })).list) {
      const u = uuidOf(x);
      if (u) m.set(u, obj(x));
    }
    return m;
  } catch { return null; }
}

/** Aria's Fast voices (GET /voices/fast) as id -> the item. Best effort: null when Aria cannot be asked. Items without an id are dropped. */
async function ariaFastList(): Promise<Map<string, Record<string, any>> | null> {
  try {
    const m = new Map<string, Record<string, any>>();
    for (const x of splitModels(await ariaOk("/voices/fast", { admin: true })).list) {
      const o = obj(x);
      const id = isText(o.id) ? o.id : isText(o.name) ? o.name : null;
      if (id) m.set(id, o);
    }
    return m;
  } catch { return null; }
}

/** A Fast voice is ready when Aria says so (`ready`, a boolean). Without that flag: its .onnx ("model") and config ("config") are both there. */
function fastReady(o: Record<string, any> | undefined): boolean {
  if (!o) return false;
  if (typeof o.ready === "boolean") return o.ready;
  const files = Array.isArray(o.files) ? o.files.filter(isText) : [];
  return files.includes("model") && files.includes("config");
}

/** Short calls to Aria for status / diagnose: any failure (no URL, timeout, refused) is null. */
const probe = (path: string, o: AriaCall = {}): Promise<AriaResult | null> =>
  ariaFetch(path, { timeoutMs: 3000, ...o }).catch(() => null);

// ---- uploads: one extension check for both windows ----
type UploadPlan = { kind: "aivmx" } | { kind: "piper"; id: string; file: "zip" | "model" | "config" };

/** The one place that checks an upload's name. `.aivmx` is the standard window, `.onnx` / `.zip` / `.json` the Fast window.
 *  Anything else is 415 unsupported_format. `kind` / `file` query values override the extension. */
function planUpload(name: string, kindParam: unknown, fileParam: unknown): UploadPlan {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  const extKind: VoiceKind | undefined = ext === ".aivmx" ? "aivmx" : [".onnx", ".zip", ".json"].includes(ext) ? "piper" : undefined;
  if (kindParam !== undefined && kindParam !== "" && kindParam !== "aivmx" && kindParam !== "piper") throw new RangeError("kind must be aivmx or piper");
  const kind = kindParam === "aivmx" || kindParam === "piper" ? kindParam : extKind;
  if (!kind) throw new Deny(415, "Only .aivmx, .onnx, .zip and .json files can be uploaded", "unsupported_format");
  if (kind === "aivmx") {
    if (ext !== ".aivmx") throw new Deny(415, "A standard voice must be a .aivmx file", "unsupported_format");
    return { kind };
  }
  if (extKind !== "piper") throw new Deny(415, "A Fast voice must be a .onnx, .zip or .json file", "unsupported_format");
  const fileDefault = ext === ".zip" ? "zip" : ext === ".json" ? "config" : "model";
  const file = fileParam === undefined || fileParam === "" ? fileDefault : fileParam;
  if (file !== "zip" && file !== "model" && file !== "config") throw new RangeError("file must be zip, model or config");
  // Aria's id: lowercase letters, digits, - and _, at most 40 characters, from the file name without its extension.
  const id = name.slice(0, dot).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  if (!id) throw new RangeError("name must contain letters or digits");
  return { kind: "piper", id, file };
}

/** The model Aria created when it answered without a body (204): the new uuid in the list after the upload, matched by name. */
async function findNewAriaModel(before: Map<string, unknown> | null, name: string): Promise<string | null> {
  const after = await ariaModelMap("/voices");
  if (!after) return null;
  const stem = name.replace(/\.[^.]*$/, "");
  const fresh = [...after].filter(([u]) => !before?.has(u));
  const byName = fresh.filter(([, m]) => [m.name, m.file, m.filename].some((v) => v === name || v === stem));
  const pick = byName.length === 1 ? byName : before && fresh.length === 1 ? fresh : [];
  return pick.length === 1 ? pick[0][0] : null;
}

async function uploadAivmx(userId: string, name: string, bytes: Buffer): Promise<Record<string, unknown>> {
  const before = await ariaModelMap("/voices");
  const r = await ariaFetch("/voices/models", { method: "POST", admin: true, query: { name }, bytes, timeoutMs: 180_000 });
  if (r.status < 200 || r.status >= 300) throw ariaFailure(r);
  const j = obj(r.json);
  const info = obj(j.model ?? j);
  const uuid = [info.uuid, info.id, j.uuid, j.id].find(isText) ?? await findNewAriaModel(before, name);
  if (!uuid) throw new VoiceError(502, "aria_error", "The voice server did not return a model id");
  addVoiceModel(uuid, userId, name, "aivmx");
  return { ...info, uuid, name, kind: "aivmx", ownerUserId: userId };
}

async function uploadPiper(userId: string, id: string, file: "zip" | "model" | "config", bytes: Buffer): Promise<Record<string, unknown>> {
  const r = await ariaFetch("/voices/fast/models", { method: "POST", admin: true, query: { name: id, file }, bytes, timeoutMs: 180_000 });
  if (r.status === 422) throw new VoiceError(422, "unsupported_format", safeMessage(r.json?.error) ?? safeMessage(r.json?.message) ?? "The voice server cannot import this file");
  if (r.status < 200 || r.status >= 300) throw ariaFailure(r);
  const info = obj(obj(r.json).model ?? r.json);
  const uuid = isText(info.id) ? info.id : id;
  addVoiceModel(uuid, userId, id, "piper");
  return { ...info, id: uuid, uuid, name: id, kind: "piper", ownerUserId: userId };
}

// ---- diagnose ----
interface Check { id: string; ok: boolean; message: string; hint: string }
const check = (id: string, ok: boolean, message: string, hint = ""): Check => ({ id, ok, message, hint: ok ? "" : hint });
const txt = (v: unknown): string => safeMessage(v) ?? "?";

/**
 * Aria's GET /llm/endpoints (its exact shape is not fixed) as `{ endpoints:[{id,name,model}], roles:{fast:{endpoint,model},...}, usage }`.
 * Endpoints may be a list of objects / names or a map; roles an object (role -> model text or {endpoint, model}) or a list of {role, endpoint, model}.
 */
export function normalizeLlm(raw: unknown): { endpoints: { id: string; name: string; model: string }[]; roles: Record<string, { endpoint: string; model: string }>; usage: unknown } {
  const o = obj(raw);
  const eps: { id: string; name: string; model: string }[] = [];
  const src = o.endpoints ?? o.items ?? [];
  const add = (name: unknown, v: unknown) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n || eps.some((e) => e.id === n)) return;
    eps.push({ id: n, name: n, model: typeof obj(v).model === "string" ? obj(v).model : "" });
  };
  if (Array.isArray(src)) for (const e of src) typeof e === "string" ? add(e, {}) : add(obj(e).name ?? obj(e).id, e);
  else for (const [k, v] of Object.entries(obj(src))) add(k, v);
  const roles: Record<string, { endpoint: string; model: string }> = {};
  const rs = o.roles ?? {};
  const put = (role: unknown, v: unknown) => {
    if (typeof role !== "string" || !role) return;
    const r = obj(v);
    roles[role] = { endpoint: typeof v === "string" ? "" : typeof r.endpoint === "string" ? r.endpoint : typeof r.name === "string" ? r.name : "", model: typeof v === "string" ? v : typeof r.model === "string" ? r.model : "" };
  };
  if (Array.isArray(rs)) for (const r of rs) put(obj(r).role ?? obj(r).name, r);
  else for (const [k, v] of Object.entries(obj(rs))) put(k, v);
  return { endpoints: eps, roles, usage: o.usage ?? o.roles_usage ?? {} };
}

/** A role counts as assigned when Aria's endpoints answer lists a model for it (roles as an object or a list). */
function roleAssigned(endpoints: any, role: string): boolean {
  const hasModel = (v: unknown): boolean => typeof v === "string" ? v.trim() !== "" : isText(obj(v).model);
  const roles = endpoints?.roles ?? endpoints;
  if (Array.isArray(roles)) return roles.some((x) => obj(x).role === role && hasModel(x));
  return !!roles && typeof roles === "object" && hasModel((roles as Record<string, unknown>)[role]);
}

async function diagnose(): Promise<Check[]> {
  if (readVoiceConfig().mode === "off") {
    return [check("voice_off", false, "音声通話は、オフになっています。", "管理者は、Server の「音声通話」で、モードを選んでください。")];
  }
  const reach = "Server アプリで Aria が起動しているか、外部の Aria の URL が正しいかを確認してください。";
  const health = await probe("/health");
  if (!health || health.status !== 200) {
    return [
      check("aria_reachable", false, "Aria に届きません。", reach),
      ...["aria_health", "stt", "tts_modes", "llm_roles"].map((id) => check(id, false, "Aria に届かないため、確認できません。", reach)),
    ];
  }
  const out: Check[] = [check("aria_reachable", true, "Aria に届きました。")];

  const status = isText(health.json?.status) ? health.json.status : "ok";
  out.push(status === "ok"
    ? check("aria_health", true, "Aria の状態: ok")
    : check("aria_health", false, `Aria の状態: ${txt(status)}`, "Aria のログを確認してください。Server アプリの「音声通話」で、ログの末尾を見られます。"));

  const placement = await probe("/voice/placement", { admin: true });
  if (placement?.status !== 200) {
    const hint = "Aria の設定を読めません。Aria の状態を確認してください。";
    out.push(check("stt", false, "文字起こし(Whisper)の状態が読めません。", hint), check("tts_modes", false, "声の方式が読めません。", hint));
  } else {
    const stt = obj(placement.json?.stt);
    out.push(isText(stt.model)
      ? check("stt", true, `文字起こし: ${txt(stt.model)}${isText(stt.device) ? ` (${txt(stt.device)})` : ""}`)
      : check("stt", false, "文字起こし(Whisper)の状態が読めません。", "管理者は、Server の「音声通話」で、Whisper の置き場所を確認してください。"));
    const modes: string[] | null = Array.isArray(placement.json?.tts_modes) ? placement.json.tts_modes.filter(isText) : null;
    if (!modes) out.push(check("tts_modes", true, "声の方式: balanced / fast(一覧が無いため、既定として扱います)"));
    else {
      const missing = ["balanced", "fast"].filter((m) => !modes.includes(m));
      out.push(missing.length
        ? check("tts_modes", false, `声の方式が足りません: ${missing.join(", ")}`, "Aria を、標準(balanced)と Fast(fast)の両方が使える版に更新してください。")
        : check("tts_modes", true, "声の方式: balanced / fast"));
    }
  }

  const ep = await probe("/llm/endpoints", { admin: true });
  if (ep?.status !== 200) out.push(check("llm_roles", false, "LLM の接続の一覧を読めません。", reach));
  else {
    const missing = ["fast", "deep"].filter((r) => !roleAssigned(ep.json, r));
    out.push(missing.length
      ? check("llm_roles", false, `LLM の役割が未設定: ${missing.join(", ")}`, "管理者は、Server の「音声通話」で、役割 fast と deep のモデルを指定してください。")
      : check("llm_roles", true, "LLM の役割: fast / deep が設定されています。"));
  }
  return out;
}

export function registerVoiceRoutes(app: FastifyInstance): void {
  // ---- status / own prefs ----
  app.get("/voice/status", guard(async (req) => {
    const userId = caller(req);
    const cfg = readVoiceConfig();
    let ready = false;
    let ttsModes = ["balanced", "fast"];
    // Not called when voice is off. Ready = Aria's /health and /voice/placement both answer 200.
    if (cfg.mode !== "off") {
      const [health, placement] = await Promise.all([probe("/health"), probe("/voice/placement", { admin: true })]);
      ready = health?.status === 200 && placement?.status === 200;
      const modes = Array.isArray(placement?.json?.tts_modes) ? placement.json.tts_modes.filter(isText) : [];
      if (ready && modes.length) ttsModes = modes;
    }
    const prefs = getPrefs(userId);
    return { mode: cfg.mode, ready, ttsModes, me: { ...prefs, effective: effectivePrefs(prefs) }, canAdmin: isAdminUser(userId) };
  }));

  app.get("/voice/me", guard(async (req) => {
    const p = getPrefs(caller(req));
    return { ...p, effective: effectivePrefs(p) };
  }));

  app.put("/voice/me", guard(async (req) => {
    const p = saveOwnPrefs(caller(req), req.body);
    return { ...p, effective: effectivePrefs(p) };
  }));

  // ---- own usage ----
  app.get("/voice/usage", guard(async (req) => {
    const userId = caller(req);
    return {
      today: voiceUsageToday(userId),
      days: voiceUsageDays(userId, 30),
      // the limit that applies to this user (their override, else the common one)
      dailyLimitMinutes: voiceQuotaMinutes(userId),
      exceeded: voiceQuotaExceeded(userId),
    };
  }));

  // ---- diagnose (any logged-in user) ----
  app.get("/voice/diagnose", guard(async (req) => {
    caller(req);
    try {
      return await diagnose();
    } catch {
      return [check("diagnose", false, "診断を完了できませんでした。", "しばらくしてから、もう一度試してください。")];
    }
  }));

  // ---- voice preview (read a short text in a voice) ----
  app.post("/voice/preview", guard(async (req, reply) => {
    const userId = caller(req);
    const b = obj(req.body);
    const text = b.text === undefined ? TTS_PREVIEW_DEFAULT : b.text;
    if (typeof text !== "string" || text.length < 1 || text.length > 200) throw new RangeError("text must be 1 to 200 characters");
    if (b.ttsMode !== undefined && b.ttsMode !== "balanced" && b.ttsMode !== "fast") throw new RangeError("ttsMode must be balanced or fast");
    if (b.voice !== undefined && (typeof b.voice !== "string" || b.voice.length > 200)) throw new RangeError("voice must be a string");
    const prefs = getPrefs(userId);
    const eff = effectivePrefs({ ...prefs, ...(b.ttsMode ? { ttsMode: b.ttsMode as "balanced" | "fast" } : {}) });
    const voice = typeof b.voice === "string" ? b.voice : prefs.voice;
    const r = await ariaFetchBinary("/tts/preview", {
      method: "POST",
      json: { text, tts_mode: eff.ttsMode, voice, speed: eff.speed },
      timeoutMs: 30_000,
    });
    if (r.status === 404 || r.status === 405 || r.status === 501) throw new VoiceError(501, "not_supported_yet", "The voice server has no read-aloud preview yet");
    if (r.status < 200 || r.status >= 300) throw ariaFailure(r);
    if (!r.bytes?.length) throw new VoiceError(502, "aria_error", "The voice server returned no audio");
    reply.header("content-type", "audio/wav");
    return r.bytes;
  }));

  // ---- voice models ----
  app.get("/voice/voices", guard(async (req) => {
    const userId = caller(req);
    const { rest, list } = splitModels(await ariaOk("/voices"));
    // Fast-mode voices: best effort. Unknown answers are skipped, not an error.
    const fast = await ariaModelMap("/voices/fast");
    const owners = new Map(listVoiceModels().map((m) => [m.uuid, m.ownerUserId]));
    const withOwner = (kind: VoiceKind, u: string | null, m: unknown) => {
      const owner = u ? owners.get(u) ?? null : null;
      return { ...obj(m), ...(kind === "piper" && u ? { uuid: u } : {}), kind, ownerUserId: owner, mine: owner !== null && owner === userId };
    };
    const models = [
      ...list.map((m) => withOwner("aivmx", uuidOf(m), m)),
      ...[...(fast?.entries() ?? [])].map(([u, m]) => withOwner("piper", u, m)),
    ];
    return { ...rest, models };
  }));

  // Raw bytes upload. Scoped so that only this route gets the octet-stream parser (the root keeps application/json).
  // The auth check runs in onRequest, before the 300 MB body is read.
  app.register(async (sub) => {
    sub.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body));
    sub.post("/voice/voices/models", {
      bodyLimit: UPLOAD_LIMIT,
      onRequest: async (req, reply) => {
        try { caller(req); } catch { return reply.code(401).send({ error: "Unauthorized" }); }
      },
    }, guard(async (req) => {
      const userId = caller(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const name = String(q.name ?? "");
      if (!SAFE_NAME.test(name) || name.includes("..")) throw new Deny(400, "name must be a plain file name");
      const plan = planUpload(name, q.kind, q.file);
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Deny(400, "The request body is empty");
      return plan.kind === "piper"
        ? uploadPiper(userId, plan.id, plan.file, bytes)
        : uploadAivmx(userId, name, bytes);
    }));
  });

  app.delete("/voice/voices/models/:uuid", guard(async (req) => {
    const userId = caller(req);
    const { uuid } = req.params as { uuid: string };
    const row = getVoiceModel(uuid);
    const isAdmin = isAdminUser(userId);
    if (!row && !isAdmin) throw new Deny(404, "Voice model not found");
    if (row && row.ownerUserId !== userId && !isAdmin) throw new Deny(403, "Forbidden");
    if (uuid === BUILTIN_VOICE) throw new Deny(400, "The built-in voice cannot be deleted", "builtin_voice");
    // a voice with no owner row (admin only) is addressed by ?kind=piper
    const piper = row ? row.kind === "piper" : (req.query as { kind?: string })?.kind === "piper";
    const path = piper ? `/voices/fast/${encodeURIComponent(uuid)}` : `/voices/models/${encodeURIComponent(uuid)}`;
    const r = await ariaFetch(path, { method: "DELETE", admin: true });
    if (r.status === 404) {
      // Already gone on Aria: an unknown model is a 404, a stale row is cleaned up.
      if (!row) throw new Deny(404, "Voice model not found");
    } else if (r.status < 200 || r.status >= 300) {
      throw ariaFailure(r);
    }
    removeVoiceModel(uuid);
    return { ok: true };
  }));

  // ---- admin: server config ----
  app.get("/voice/admin/config", guard(async (req) => {
    admin(req);
    return readVoiceConfig();
  }));

  app.put("/voice/admin/config", guard(async (req) => {
    admin(req);
    return updateVoiceConfig(req.body);
  }));

  // userId absent: the common daily limit. userId given: that user's override (null removes it, 0 = unlimited).
  app.put("/voice/admin/quota", guard(async (req) => {
    admin(req);
    const b = obj(req.body);
    const d = b.dailyMinutes;
    if (d !== null && !(typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 1440)) {
      throw new RangeError("dailyMinutes must be an integer from 0 to 1440, or null");
    }
    if (b.userId !== undefined && b.userId !== null && typeof b.userId !== "string") throw new RangeError("userId must be a string");
    const userId: string | null = typeof b.userId === "string" ? b.userId : null;
    if (userId !== null && !db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) throw new Deny(404, "User not found");
    setVoiceQuota(userId, d);
    return {
      ok: true,
      userId,
      dailyMinutes: userId === null ? readVoiceConfig().dailyLimitMinutes : (readUserDailyMinutes()[userId] ?? null),
      dailyLimitMinutes: readVoiceConfig().dailyLimitMinutes,
    };
  }));

  // ---- admin: LLM (the call's LLM is one setting for all users) ----
  app.get("/voice/admin/llm", guard(async (req) => {
    admin(req);
    const raw = await ariaOk("/llm/endpoints", { admin: true });
    const view = normalizeLlm(raw);
    // Best effort: the model lists are optional (one per endpoint, plus the default provider's).
    const modelNames = (v: unknown): string[] => splitModels(v).list.map((x) => (typeof x === "string" ? x : String(obj(x).id ?? obj(x).name ?? ""))).filter(Boolean).slice(0, 500);
    const endpoints = [];
    for (const e of view.endpoints.slice(0, 20)) {
      let models: string[] = [];
      try { models = modelNames(await ariaOk(`/llm/models?endpoint=${encodeURIComponent(e.name)}`, { admin: true })); } catch { /* not available */ }
      endpoints.push({ ...e, models });
    }
    let models: string[] = [];
    try { models = modelNames(await ariaOk("/llm/models", { admin: true })); } catch { /* not available: empty */ }
    return { endpoints, roles: view.roles, usage: view.usage, models };
  }));

  app.put("/voice/admin/llm/roles", guard(async (req) => {
    admin(req);
    const b = obj(req.body);
    if (b.role !== "fast" && b.role !== "deep") throw new RangeError("role must be fast or deep");
    if (typeof b.model !== "string" || !b.model.trim() || b.model.length > 300) throw new RangeError("model must be a non-empty string");
    if (b.endpoint !== undefined && (typeof b.endpoint !== "string" || b.endpoint.length > 200)) throw new RangeError("endpoint must be a string");
    // The request shape for Aria (target "role", plus endpoint when given) is unconfirmed; Aria's 400 with `available` is passed through.
    return ariaOk("/llm/model", {
      method: "POST",
      admin: true,
      json: { target: "role", name: b.role, model: b.model.trim(), ...(b.endpoint !== undefined ? { endpoint: b.endpoint } : {}) },
    });
  }));

  // ---- admin: users and usage ----
  const userRows = () => db.prepare("SELECT id, username, is_admin, disabled_at FROM users ORDER BY created_at, rowid").all() as any[];

  app.get("/voice/admin/users", guard(async (req) => {
    admin(req);
    const counts = new Map<string, number>();
    for (const m of listVoiceModels()) counts.set(m.ownerUserId, (counts.get(m.ownerUserId) ?? 0) + 1);
    const usage = voiceUsageByUser(30);
    return {
      users: userRows().map((u) => ({
        id: u.id,
        username: u.username,
        isAdmin: Number(u.is_admin) === 1,
        disabled: u.disabled_at != null,
        prefs: getPrefs(u.id),
        models: counts.get(u.id) ?? 0,
        today: usage.get(u.id)?.today ?? emptyVoiceUsage(),
      })),
    };
  }));

  // ?days=7 or 30 (default 30): the period of callMinutes / turns / replyChars. last30 is always the last 30 days.
  app.get("/voice/admin/usage", guard(async (req) => {
    admin(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const days = q.days === undefined || q.days === "" ? 30 : Number(q.days);
    if (days !== 7 && days !== 30) throw new RangeError("days must be 7 or 30");
    const period = voiceUsageByUser(days);
    const last30 = days === 30 ? period : voiceUsageByUser(30);
    const overrides = readUserDailyMinutes();
    const common = readVoiceConfig().dailyLimitMinutes;
    return {
      days,
      defaultDailyMinutes: common,
      dailyLimitMinutes: common,
      users: userRows().map((u) => {
        const p = period.get(u.id)?.period ?? emptyVoiceUsage();
        return {
          id: u.id,
          username: u.username,
          isAdmin: Number(u.is_admin) === 1,
          today: period.get(u.id)?.today ?? emptyVoiceUsage(),
          last30: last30.get(u.id)?.period ?? emptyVoiceUsage(),
          callMinutes: Math.round(p.callSeconds / 6) / 10,
          turns: p.turns,
          replyChars: p.replyChars,
          dailyMinutes: overrides[u.id] ?? null,
        };
      }),
    };
  }));

  // ---- admin: placement (Whisper) ----
  app.get("/voice/admin/placement", guard(async (req) => {
    admin(req);
    return ariaOk("/voice/placement", { admin: true });
  }));

  app.put("/voice/admin/placement/stt", guard(async (req) => {
    admin(req);
    const b = obj(req.body);
    const json: Record<string, unknown> = {};
    if (b.model !== undefined) json.model = b.model;
    if (b.device !== undefined) json.device = b.device;
    const idx = b.device_index ?? b.deviceIndex;
    if (idx !== undefined) json.device_index = idx;
    if (b.url !== undefined) json.url = b.url;
    if (b.token !== undefined) json.token = b.token;
    return ariaOk("/voice/placement/stt", { method: "POST", admin: true, json });
  }));

  // ---- admin: all voice models ----
  // Each model: kind, ready (Fast: Aria's flag or its files; standard: always true), builtin (no owner row: Aria's own voice, e.g. tsukuyomi).
  // Aria's Fast voices that have no row here are listed too (builtin). Aria not answering = the rows only, Fast ones not ready.
  app.get("/voice/admin/models", guard(async (req) => {
    admin(req);
    const names = new Map((db.prepare("SELECT id, username FROM users").all() as any[]).map((u) => [u.id as string, u.username as string]));
    const live = readVoiceConfig().mode !== "off";
    // Best effort: Aria's info is joined when it answers; the rows are listed either way.
    const std = (live && (await ariaModelMap("/voices"))) || new Map<string, Record<string, unknown>>();
    const fast = (live && (await ariaFastList())) || new Map<string, Record<string, any>>();
    const rows = listVoiceModels();
    const out: Record<string, unknown>[] = rows.map((m) => {
      const info = m.kind === "piper" ? fast.get(m.uuid) : std.get(m.uuid);
      return {
        ...(info ?? {}),
        uuid: m.uuid,
        name: m.name,
        kind: m.kind,
        ownerUserId: m.ownerUserId,
        ownerUsername: names.get(m.ownerUserId) ?? null,
        createdAt: m.createdAt,
        builtin: false,
        ready: m.kind === "piper" ? fastReady(info) : true,
      };
    });
    const known = new Set(rows.map((m) => m.uuid));
    for (const [id, o] of fast) {
      if (known.has(id)) continue;
      out.push({
        ...o,
        uuid: id,
        name: isText(o.name) ? o.name : id,
        kind: "piper",
        ownerUserId: null,
        ownerUsername: null,
        createdAt: null,
        builtin: true,
        ready: fastReady(o),
      });
    }
    return { models: out };
  }));
}
