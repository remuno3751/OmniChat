// Aria voice call: stored settings (server_settings "voice"), per-user prefs, voice-model owners (docs/design/ARIA-HOST.md).
// Tokens are encrypted at rest and never returned: readers get `chatTokenSet` / `adminTokenSet` only.
import { db } from "./db.js";
import { encryptSecret, decryptSecret } from "./secret.js";

export type VoiceMode = "off" | "hosted" | "external";
/** aivmx: standard mode (AivisSpeech). piper: Fast mode (piper-plus). */
export type VoiceKind = "aivmx" | "piper";
export interface VoiceServerConfig {
  mode: VoiceMode;
  baseUrl: string;
  /** Call time per user and local day, in minutes. 0 = unlimited. */
  dailyLimitMinutes: number;
}
export interface VoiceConfigPublic extends VoiceServerConfig { chatTokenSet: boolean; adminTokenSet: boolean }
export interface VoiceUserPrefs {
  voice?: string; ttsMode?: "balanced" | "fast"; speed?: number; pauseScale?: number; responseDelayMs?: number;
  endOfTurnMs?: number; bargeIn?: boolean; bargeInDb?: number;
}

const KEY = "voice";
/** Older stored `allowedLlm` is ignored (and dropped on the next write). */
/** userDailyMinutes: per-user override of dailyLimitMinutes (user id -> minutes, 0 = unlimited). Absent = none. */
interface Stored { mode?: VoiceMode; baseUrl?: string; chatToken?: string; adminToken?: string; dailyLimitMinutes?: number; userDailyMinutes?: Record<string, number> }

function readStored(): Stored {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}
function writeStored(s: Stored): void {
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(s), Date.now());
}

const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.length <= max ? v : null);
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

export function readVoiceConfig(): VoiceConfigPublic {
  const s = readStored();
  return {
    mode: s.mode === "hosted" || s.mode === "external" ? s.mode : "off",
    baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : "",
    dailyLimitMinutes: int(s.dailyLimitMinutes, 0, 1440) ?? 0,
    chatTokenSet: !!s.chatToken, adminTokenSet: !!s.adminToken,
  };
}

/** Server-internal: the decrypted tokens. Never put these in a response, a log line or an error message. */
/** The per-user overrides of the daily limit (user id -> minutes). Unset or malformed entries read as none (an empty object). */
export function readUserDailyMinutes(): Record<string, number> {
  const raw = readStored().userDailyMinutes;
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, v] of Object.entries(raw)) {
      const n = int(v, 0, 1440);
      if (id && n !== undefined) out[id] = n;
    }
  }
  return out;
}

/**
 * Sets the daily limit: the common one (userId null; null = unlimited, stored as 0) or one user's override
 * (null removes the override). Throws RangeError on a bad value. The caller checks that the user exists.
 */
export function setVoiceQuota(userId: string | null, dailyMinutes: number | null): void {
  if (dailyMinutes !== null && int(dailyMinutes, 0, 1440) === undefined) throw new RangeError("dailyMinutes must be an integer from 0 to 1440, or null");
  const s = readStored();
  if (userId === null) {
    s.dailyLimitMinutes = dailyMinutes ?? 0;
  } else {
    const map = readUserDailyMinutes();
    if (dailyMinutes === null) delete map[userId];
    else map[userId] = dailyMinutes;
    s.userDailyMinutes = map;
  }
  writeStored(s);
}

export function voiceSecrets(): { baseUrl: string; chatToken: string; adminToken: string } {
  const s = readStored();
  return { baseUrl: typeof s.baseUrl === "string" ? s.baseUrl.replace(/\/+$/, "") : "", chatToken: decryptSecret(s.chatToken), adminToken: decryptSecret(s.adminToken) };
}

/** Partial update. A token that is absent (or null/undefined) is kept; "" clears it. Throws RangeError on bad input. */
export function updateVoiceConfig(body: unknown): VoiceConfigPublic {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const s = readStored();
  if (b.mode !== undefined) {
    if (b.mode !== "off" && b.mode !== "hosted" && b.mode !== "external") throw new RangeError("mode must be off, hosted or external");
    s.mode = b.mode;
  }
  if (b.baseUrl !== undefined) {
    const u = str(b.baseUrl, 500);
    if (u === null) throw new RangeError("baseUrl must be a string");
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new RangeError("baseUrl must start with http:// or https://");
    s.baseUrl = u.replace(/\/+$/, "");
  }
  for (const k of ["chatToken", "adminToken"] as const) {
    if (b[k] === undefined || b[k] === null) continue;
    const t = str(b[k], 2000);
    if (t === null) throw new RangeError(`${k} must be a string`);
    s[k] = encryptSecret(t.trim());
  }
  if (b.dailyLimitMinutes !== undefined) {
    const n = int(b.dailyLimitMinutes, 0, 1440);
    if (n === undefined) throw new RangeError("dailyLimitMinutes must be an integer from 0 to 1440");
    s.dailyLimitMinutes = n;
  }
  delete (s as Stored & { allowedLlm?: unknown }).allowedLlm;
  writeStored(s);
  return readVoiceConfig();
}

// ---- per-user prefs ----
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

/** Rounds into the ranges of the Aria contract; unknown keys (including old `llm`) are dropped. */
export function sanitizePrefs(v: unknown): VoiceUserPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const p: VoiceUserPrefs = {};
  if (typeof o.voice === "string" && o.voice.length <= 200) p.voice = o.voice;
  if (o.ttsMode === "balanced" || o.ttsMode === "fast") p.ttsMode = o.ttsMode;
  const sp = num(o.speed, 0.5, 2); if (sp !== undefined) p.speed = sp;
  const ps = num(o.pauseScale, 0, 2); if (ps !== undefined) p.pauseScale = ps;
  const rd = num(o.responseDelayMs, 0, 3000); if (rd !== undefined) p.responseDelayMs = Math.round(rd);
  const eo = num(o.endOfTurnMs, 200, 3000); if (eo !== undefined) p.endOfTurnMs = Math.round(eo);
  if (typeof o.bargeIn === "boolean") p.bargeIn = o.bargeIn;
  const bd = num(o.bargeInDb, -70, -10); if (bd !== undefined) p.bargeInDb = bd;
  return p;
}

export function getPrefs(userId: string): VoiceUserPrefs {
  try {
    const r = db.prepare("SELECT prefs FROM voice_user_prefs WHERE user_id = ?").get(userId) as { prefs: string } | undefined;
    return sanitizePrefs(r ? JSON.parse(r.prefs) : {});
  } catch { return {}; }
}
export function setPrefs(userId: string, p: VoiceUserPrefs): void {
  db.prepare("INSERT INTO voice_user_prefs (user_id, prefs, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at")
    .run(userId, JSON.stringify(p), Date.now());
}

/** PUT /voice/me: replaces the user's own settings. */
export function saveOwnPrefs(userId: string, body: unknown): VoiceUserPrefs {
  const p = sanitizePrefs(body);
  setPrefs(userId, p);
  return p;
}

/** Prefs with the built-in defaults filled in (balanced speed 1.3, fast 1.0). */
export function effectivePrefs(p: VoiceUserPrefs): VoiceUserPrefs & { ttsMode: "balanced" | "fast"; speed: number } {
  const ttsMode = p.ttsMode ?? "balanced";
  return { ...p, ttsMode, speed: p.speed ?? (ttsMode === "balanced" ? 1.3 : 1.0) };
}

/** Aria-side setting names (snake_case) for hello/settings `values`, from prefs. */
export function prefsToAriaValues(p: VoiceUserPrefs): Record<string, number | string | boolean> {
  const e = effectivePrefs(p);
  const v: Record<string, number | string | boolean> = { tts_mode: e.ttsMode, speed: e.speed };
  if (p.voice) v.voice = p.voice;
  if (p.pauseScale !== undefined) v.pause_scale = p.pauseScale;
  if (p.responseDelayMs !== undefined) v.response_delay_ms = p.responseDelayMs;
  if (p.endOfTurnMs !== undefined) v.end_of_turn_ms = p.endOfTurnMs;
  if (p.bargeIn !== undefined) v.barge_in = p.bargeIn;
  if (p.bargeInDb !== undefined) v.barge_in_db = p.bargeInDb;
  return v;
}

// ---- voice-model owners ----
export interface VoiceModelRow { uuid: string; ownerUserId: string; name: string; kind: VoiceKind; createdAt: number }
const toModel = (r: any): VoiceModelRow => ({ uuid: r.uuid, ownerUserId: r.owner_user_id, name: r.name, kind: r.kind === "piper" ? "piper" : "aivmx", createdAt: r.created_at });
export function addVoiceModel(uuid: string, ownerUserId: string, name: string, kind: VoiceKind): void {
  db.prepare("INSERT OR REPLACE INTO voice_models (uuid, owner_user_id, name, kind, created_at) VALUES (?,?,?,?,?)").run(uuid, ownerUserId, name, kind, Date.now());
}
export function getVoiceModel(uuid: string): VoiceModelRow | null {
  const r = db.prepare("SELECT * FROM voice_models WHERE uuid = ?").get(uuid);
  return r ? toModel(r) : null;
}
export function listVoiceModels(ownerUserId?: string): VoiceModelRow[] {
  const rows = ownerUserId
    ? db.prepare("SELECT * FROM voice_models WHERE owner_user_id = ? ORDER BY created_at").all(ownerUserId)
    : db.prepare("SELECT * FROM voice_models ORDER BY created_at").all();
  return (rows as any[]).map(toModel);
}
export function removeVoiceModel(uuid: string): void {
  db.prepare("DELETE FROM voice_models WHERE uuid = ?").run(uuid);
}
