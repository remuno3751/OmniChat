/* DB-backed update settings and runtime cache (table server_settings).
   key "update": channel, checkHours, skipped versions, githubToken (encrypted with encryptSecret, never returned).
   key "update_state": last check time, last error, ETag and cached releases. */
import { db } from "../db.js";
import { decryptSecret, encryptSecret } from "../secret.js";
import type { Channel, ReleaseInfo, UpdateError } from "./types.js";

const KEY_SETTINGS = "update";
const KEY_RUNTIME = "update_state";
const CHANNELS: readonly Channel[] = ["stable", "prerelease"];
const MAX_SKIPPED = 100;
const DEFAULT_CHECK_HOURS = 12;
const MAX_CHECK_HOURS = 720;

/** Names the settings UI uses for these values. */
export const UPDATE_SETTING_NAMES = {
  checkHours: "updateCheckHours",
  githubToken: "updateGithubToken",
  channel: "updateChannel",
  skipped: "updateSkipped",
} as const;

export interface UpdateSettings {
  channel: Channel;
  checkHours: number;
  skipped: string[];
  tokenSet: boolean;
}

export interface UpdateRuntime {
  lastCheckedAt: number | null;
  lastError: UpdateError | null;
  etag: string | null;
  releases: ReleaseInfo[] | null;
}

export interface UpdateSettingsPatch {
  channel?: Channel;
  checkHours?: number;
  /** string = set (encrypted), empty or null = clear. */
  githubToken?: string | null;
}

interface StoredSettings {
  channel?: unknown;
  checkHours?: unknown;
  skipped?: unknown;
  githubToken?: unknown;
}

function readRow<T extends object>(key: string): Partial<T> {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(key) as { value: string } | undefined;
    const j = row ? JSON.parse(row.value) : {};
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Partial<T>) : {};
  } catch { return {}; }
}

function writeRow(key: string, value: unknown): void {
  db.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, JSON.stringify(value), Date.now());
}

/** Keeps 0..720 whole hours. Non-numbers fall back to `fallback`. */
export function clampCheckHours(n: unknown, fallback = DEFAULT_CHECK_HOURS): number {
  const v = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(MAX_CHECK_HOURS, Math.max(0, Math.trunc(v)));
}

const isChannel = (x: unknown): x is Channel => typeof x === "string" && (CHANNELS as readonly string[]).includes(x);

/** Accepts "1.2.3" or "v1.2.3"; returns the bare version or throws. */
function normVersion(v: string): string {
  const t = String(v ?? "").trim().replace(/^v/i, "");
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(t)) throw new Error("invalid version");
  return t;
}

/** Effective settings: DB value wins, then the env default (OMNICHAT_UPDATE_CHANNEL / OMNICHAT_UPDATE_CHECK_HOURS), then built-in. */
export function getUpdateSettings(): UpdateSettings {
  const s = readRow<StoredSettings>(KEY_SETTINGS);
  const envChannel = (process.env.OMNICHAT_UPDATE_CHANNEL ?? "").trim().toLowerCase();
  const channel: Channel = isChannel(s.channel) ? s.channel : isChannel(envChannel) ? envChannel : "stable";
  const checkHours = s.checkHours !== undefined
    ? clampCheckHours(s.checkHours)
    : clampCheckHours(process.env.OMNICHAT_UPDATE_CHECK_HOURS, DEFAULT_CHECK_HOURS);
  const skipped = Array.isArray(s.skipped) ? s.skipped.filter((x): x is string => typeof x === "string").slice(0, MAX_SKIPPED) : [];
  return { channel, checkHours, skipped, tokenSet: getUpdateToken().length > 0 };
}

/** Admin update. Validation errors throw (the route maps them to 400). Returns the new effective settings. */
export function setUpdateSettings(patch: UpdateSettingsPatch): UpdateSettings {
  const s = readRow<StoredSettings>(KEY_SETTINGS);
  if (patch.channel !== undefined) {
    if (!isChannel(patch.channel)) throw new Error("channel must be stable or prerelease");
    s.channel = patch.channel;
  }
  if (patch.checkHours !== undefined) {
    if (typeof patch.checkHours !== "number" || !Number.isFinite(patch.checkHours)) throw new Error("checkHours must be a number");
    s.checkHours = clampCheckHours(patch.checkHours);
  }
  if (patch.githubToken !== undefined) {
    const t = (patch.githubToken ?? "").trim();
    if (t === "") delete s.githubToken;
    else if (/^[\x21-\x7e]{8,300}$/.test(t)) s.githubToken = encryptSecret(t);
    else throw new Error("githubToken is not a valid token");
  }
  writeRow(KEY_SETTINGS, s);
  return getUpdateSettings();
}

/** Decrypted GitHub token: the DB value, else OMNICHAT_UPDATE_TOKEN. Never log or return this to clients. */
export function getUpdateToken(): string {
  const stored = readRow<StoredSettings>(KEY_SETTINGS).githubToken;
  const fromDb = typeof stored === "string" ? decryptSecret(stored).trim() : "";
  return fromDb || (process.env.OMNICHAT_UPDATE_TOKEN ?? "").trim();
}

export function skipVersion(v: string): void {
  const n = normVersion(v);
  const s = readRow<StoredSettings>(KEY_SETTINGS);
  const list = Array.isArray(s.skipped) ? s.skipped.filter((x): x is string => typeof x === "string") : [];
  if (!list.includes(n)) list.push(n);
  s.skipped = list.slice(-MAX_SKIPPED);
  writeRow(KEY_SETTINGS, s);
}

export function unskipVersion(v: string): void {
  const n = normVersion(v);
  const s = readRow<StoredSettings>(KEY_SETTINGS);
  const list = Array.isArray(s.skipped) ? s.skipped.filter((x): x is string => typeof x === "string") : [];
  s.skipped = list.filter((x) => x !== n);
  writeRow(KEY_SETTINGS, s);
}

export function isSkipped(v: string): boolean {
  let n: string;
  try { n = normVersion(v); } catch { return false; }
  return getUpdateSettings().skipped.includes(n);
}

export function getRuntime(): UpdateRuntime {
  const r = readRow<Record<string, unknown>>(KEY_RUNTIME) as Record<string, any>;
  const err = r.lastError;
  const validErr = err && typeof err === "object" && typeof err.code === "string" && typeof err.message === "string" && typeof err.at === "number";
  return {
    lastCheckedAt: typeof r.lastCheckedAt === "number" && Number.isFinite(r.lastCheckedAt) ? r.lastCheckedAt : null,
    lastError: validErr ? (err as UpdateError) : null,
    etag: typeof r.etag === "string" ? r.etag : null,
    releases: Array.isArray(r.releases) ? (r.releases as ReleaseInfo[]) : null,
  };
}

/** Merges the given fields into the runtime cache (undefined fields are left unchanged). */
export function setRuntime(patch: Partial<UpdateRuntime>): void {
  const cur: Record<string, unknown> = { ...getRuntime() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v;
  writeRow(KEY_RUNTIME, cur);
}
