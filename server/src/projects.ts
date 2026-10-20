import { db, nextSeq, parseJson, parseToolList, parseSearchMode } from "./db.js";
import type { Effort, SamplingParams } from "./db.js";
import { sanitizeParams, sanitizeEffort } from "./sampling.js";
import type { SearchMode } from "./tools/types.js";

export interface Project {
  id: string; name: string; systemPrompt: string | null; systemMode: "append" | "replace";
  defaultProviderId: string | null; defaultModel: string | null; effort: Effort | null;
  params: SamplingParams | null; createdAt: number; updatedAt: number; deleted: boolean; seq: number;
  tools: string[] | null; searchMode: SearchMode | null;
  /** v4 */ mode: "chat" | "code";
}
export interface PromptPreset { id: string; name: string; text: string; createdAt: number; updatedAt: number; deleted: boolean; seq: number }
export type ContextOverflow = "truncate" | "summarize" | "stop";
export const CONTEXT_OVERFLOW: readonly ContextOverflow[] = ["truncate", "summarize", "stop"];
export interface Settings {
  systemPrompt: string | null; effort: Effort | null; params: SamplingParams | null; devMode: boolean;
  contextOverflow: ContextOverflow; contextLimits: Record<string, number> | null;
  tools: string[] | null; searchMode: SearchMode; autoTitle: boolean; titleModel: string | null;
  /** refresh the auto title every N completed replies; 0 = only the first title (integer 0..50) */
  titleEvery: number;
  modelParams: Record<string, SamplingParams> | null; seq: number;
  /** user override of image support per model: "<providerId>::<model>" -> true (reads images) / false (does not); see vision.ts */
  modelVision: Record<string, boolean> | null;
  /** percent of the context limit at which older turns are compressed into a summary; null = off (overflow only) */
  contextCompressAt: number | null;
  /** percent of the context limit that a compression aims for */
  contextCompressTarget: number;
  /** assumed context length (tokens) for models whose backend reports none; also the default load length */
  defaultContextLength: number | null;
  /** v4: which events notify (default all true) */
  notify: NotifyPrefs;
  /** v4: true when an ntfy-compatible URL is configured (the URL itself is never returned) */
  notifyUrlSet: boolean;
  /** v4: optional synced active pet */
  activePetId: string | null;
  /** ephemeral chats: idle minutes before they are destroyed (integer 1..1440) */
  ephemeralIdleMinutes: number;
}
export interface NotifyPrefs { done: boolean; approval: boolean; error: boolean }
export type SettingsPatch = Partial<Omit<Settings, "seq" | "notifyUrlSet">> & { notifyUrl?: string | null };

/** The raw notify URL (server use only; never put it in a response). */
export function getNotifyUrl(userId: string): string | null {
  const r = db.prepare("SELECT json FROM settings WHERE user_id = ?").get(userId) as any;
  const u = (r && parseJson(r.json))?.notifyUrl;
  return typeof u === "string" && u ? u : null;
}
const notifyOf = (v: any): NotifyPrefs => ({ done: v?.done !== false, approval: v?.approval !== false, error: v?.error !== false });

export const COMPRESS_AT_RANGE: [number, number] = [50, 95];
export const COMPRESS_TARGET_RANGE: [number, number] = [20, 80];
export const DEFAULT_CONTEXT_RANGE: [number, number] = [256, 10_000_000];
export const EPH_IDLE_RANGE: [number, number] = [1, 1440];
export const TITLE_EVERY_RANGE: [number, number] = [0, 50];
export const TITLE_EVERY_DEFAULT = 6;
export const intIn = (v: unknown, [lo, hi]: [number, number]): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Keeps only string keys with positive integer values; null if empty / not an object. */
export function sanitizeContextLimits(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k && k.length <= 600 && typeof x === "number" && Number.isInteger(x) && x > 0 && x <= 100_000_000) out[k] = x;
    if (Object.keys(out).length >= 500) break;
  }
  return Object.keys(out).length ? out : null;
}

/** Keeps valid, unique tool names (<= 100). null if not an array; [] is kept (= no tools). */
export function sanitizeToolList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) if (typeof x === "string" && /^[a-z0-9_]{1,40}$/.test(x) && !out.includes(x)) out.push(x);
  return out.slice(0, 100);
}

/** `"<providerId>::<model>"` -> sanitised SamplingParams; entries that sanitise to nothing are dropped. */
export function sanitizeModelParams(v: unknown): Record<string, SamplingParams> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, SamplingParams> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!k || k.length > 600) continue;
    const sp = sanitizeParams(x);
    if (sp) out[k] = sp;
    if (Object.keys(out).length >= 500) break;
  }
  return Object.keys(out).length ? out : null;
}

/** `"<providerId>::<model>"` -> boolean (image support override); other values are dropped. */
export function sanitizeModelVision(v: unknown): Record<string, boolean> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!k || k.length > 600 || typeof x !== "boolean") continue;
    out[k] = x;
    if (Object.keys(out).length >= 500) break;
  }
  return Object.keys(out).length ? out : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const toProject = (r: any): Project => ({
  id: r.id, name: r.name, systemPrompt: r.system_prompt ?? null,
  systemMode: r.system_mode === "replace" ? "replace" : "append",
  defaultProviderId: r.default_provider_id ?? null, defaultModel: r.default_model ?? null,
  effort: r.effort ?? null, params: parseJson(r.params),
  createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq,
  tools: parseToolList(r.tools), searchMode: parseSearchMode(r.search_mode),
  mode: r.mode === "code" ? "code" : "chat",
});
export const toPreset = (r: any): PromptPreset => ({
  id: r.id, name: r.name, text: r.text ?? "", createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq,
});

export const getProjectRow = (id: string): any => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
export const getPresetRow = (id: string): any => db.prepare("SELECT * FROM prompt_presets WHERE id = ?").get(id);

export function getSettings(userId: string): Settings {
  const r = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(userId) as any;
  const j = (r && parseJson(r.json)) || {};
  return {
    systemPrompt: typeof j.systemPrompt === "string" && j.systemPrompt ? j.systemPrompt : null,
    effort: sanitizeEffort(j.effort) ?? null,
    params: sanitizeParams(j.params),
    devMode: !!j.devMode,
    contextOverflow: CONTEXT_OVERFLOW.includes(j.contextOverflow) ? j.contextOverflow : "summarize",
    contextLimits: sanitizeContextLimits(j.contextLimits),
    tools: sanitizeToolList(j.tools),
    searchMode: parseSearchMode(j.searchMode) ?? "smart",
    autoTitle: typeof j.autoTitle === "boolean" ? j.autoTitle : process.env.AUTO_TITLE_DEFAULT !== "0",
    titleModel: typeof j.titleModel === "string" && j.titleModel ? j.titleModel : null,
    titleEvery: intIn(j.titleEvery, TITLE_EVERY_RANGE) ? j.titleEvery : TITLE_EVERY_DEFAULT,
    modelParams: sanitizeModelParams(j.modelParams),
    modelVision: sanitizeModelVision(j.modelVision),
    seq: r?.seq ?? 0,
    contextCompressAt: j.contextCompressAt === null ? null : intIn(j.contextCompressAt, COMPRESS_AT_RANGE) ? j.contextCompressAt : 80,
    contextCompressTarget: intIn(j.contextCompressTarget, COMPRESS_TARGET_RANGE) ? j.contextCompressTarget : 50,
    defaultContextLength: intIn(j.defaultContextLength, DEFAULT_CONTEXT_RANGE) ? j.defaultContextLength : null,
    notify: notifyOf(j.notify),
    notifyUrlSet: typeof j.notifyUrl === "string" && !!j.notifyUrl,
    activePetId: typeof j.activePetId === "string" && j.activePetId ? j.activePetId : null,
    ephemeralIdleMinutes: intIn(j.ephemeralIdleMinutes, EPH_IDLE_RANGE) ? j.ephemeralIdleMinutes : 30,
  };
}

/** Partial merge; fields absent from `patch` are kept. Values must be validated by the caller. */
export function saveSettings(userId: string, patch: SettingsPatch): Settings {
  const cur = getSettings(userId);
  const next = {
    systemPrompt: "systemPrompt" in patch ? patch.systemPrompt ?? null : cur.systemPrompt,
    effort: "effort" in patch ? patch.effort ?? null : cur.effort,
    params: "params" in patch ? patch.params ?? null : cur.params,
    devMode: "devMode" in patch ? !!patch.devMode : cur.devMode,
    contextOverflow: "contextOverflow" in patch && patch.contextOverflow ? patch.contextOverflow : cur.contextOverflow,
    contextLimits: "contextLimits" in patch ? patch.contextLimits ?? null : cur.contextLimits,
    tools: "tools" in patch ? patch.tools ?? null : cur.tools,
    searchMode: "searchMode" in patch && patch.searchMode ? patch.searchMode : cur.searchMode,
    autoTitle: "autoTitle" in patch ? patch.autoTitle !== false : cur.autoTitle,
    titleModel: "titleModel" in patch ? patch.titleModel ?? null : cur.titleModel,
    titleEvery: "titleEvery" in patch ? (intIn(patch.titleEvery, TITLE_EVERY_RANGE) ? patch.titleEvery : TITLE_EVERY_DEFAULT) : cur.titleEvery,
    modelParams: "modelParams" in patch ? patch.modelParams ?? null : cur.modelParams,
    modelVision: "modelVision" in patch ? patch.modelVision ?? null : cur.modelVision,
    contextCompressAt: "contextCompressAt" in patch ? patch.contextCompressAt ?? null : cur.contextCompressAt,
    contextCompressTarget: "contextCompressTarget" in patch && patch.contextCompressTarget != null ? patch.contextCompressTarget : cur.contextCompressTarget,
    defaultContextLength: "defaultContextLength" in patch ? patch.defaultContextLength ?? null : cur.defaultContextLength,
    notify: "notify" in patch ? notifyOf(patch.notify) : cur.notify,
    notifyUrl: "notifyUrl" in patch ? patch.notifyUrl ?? null : getNotifyUrl(userId),
    activePetId: "activePetId" in patch ? patch.activePetId ?? null : cur.activePetId,
    ephemeralIdleMinutes: "ephemeralIdleMinutes" in patch && intIn(patch.ephemeralIdleMinutes, EPH_IDLE_RANGE) ? patch.ephemeralIdleMinutes : cur.ephemeralIdleMinutes,
  };
  db.prepare(
    "INSERT INTO settings (user_id, json, seq) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, seq = excluded.seq",
  ).run(userId, JSON.stringify(next), nextSeq());
  return getSettings(userId);
}
