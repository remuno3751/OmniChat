import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { AuthError } from "./auth.js";
import { getSettings } from "./projects.js";
import { listSets, upsertSet, deleteSet, validateSetBody } from "./bench.js";

/* Config as files (PROTOCOL-v3-phase4.md section 5). Providers are referenced by NAME; no secrets, no conversations. */

export const CONFIG_LIMIT = 1_000_000;
const SEP = "::";

interface NameMaps { idToName: Map<string, string>; nameToId: Map<string, string> }

function providerMaps(userId: string): NameMaps {
  const idToName = new Map<string, string>();
  const nameToId = new Map<string, string>();
  for (const p of db.prepare("SELECT id, name FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY created_at, seq").all(userId) as any[]) {
    idToName.set(p.id, p.name);
    if (!nameToId.has(p.name)) nameToId.set(p.name, p.id);
  }
  return { idToName, nameToId };
}

/** "providerId::model" -> "providerName::model" (null when the provider is unknown). */
function refToName(ref: string, m: NameMaps): string | null {
  const i = ref.indexOf(SEP);
  if (i <= 0) return null;
  const name = m.idToName.get(ref.slice(0, i));
  return name ? name + SEP + ref.slice(i + SEP.length) : null;
}
function refToId(ref: string, m: NameMaps): string | null {
  const i = ref.indexOf(SEP);
  if (i <= 0) return null;
  const id = m.nameToId.get(ref.slice(0, i));
  return id ? id + SEP + ref.slice(i + SEP.length) : null;
}
function mapKeys<T>(obj: Record<string, T> | null, f: (k: string) => string | null): Record<string, T> | null {
  if (!obj) return null;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) { const n = f(k); if (n) out[n] = v; }
  return Object.keys(out).length ? out : null;
}

export function buildExport(userId: string) {
  const m = providerMaps(userId);
  const s = getSettings(userId);
  const projects = (db.prepare("SELECT * FROM projects WHERE user_id = ? AND deleted = 0 ORDER BY created_at, rowid").all(userId) as any[]).map((r) => {
    const parse = (v: any) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    const defaultModel = r.default_provider_id && r.default_model && m.idToName.get(r.default_provider_id)
      ? m.idToName.get(r.default_provider_id) + SEP + r.default_model : null;
    return {
      name: r.name, systemPrompt: r.system_prompt ?? null, systemMode: r.system_mode === "replace" ? "replace" : "append",
      defaultModel, effort: r.effort ?? null, params: parse(r.params), tools: parse(r.tools), searchMode: r.search_mode ?? null,
    };
  });
  const presets = (db.prepare("SELECT name, text FROM prompt_presets WHERE user_id = ? AND deleted = 0 ORDER BY created_at, rowid").all(userId) as any[])
    .map((r) => ({ name: r.name, text: r.text ?? "" }));
  const benchSets = listSets(userId).map((b) => ({ name: b.name, prompts: b.prompts, systemPrompt: b.systemPrompt }));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      systemPrompt: s.systemPrompt, effort: s.effort, params: s.params,
      modelParams: mapKeys(s.modelParams, (k) => refToName(k, m)),
      tools: s.tools, searchMode: s.searchMode, autoTitle: s.autoTitle, titleEvery: s.titleEvery,
      titleModel: s.titleModel ? refToName(s.titleModel, m) : null,
      search: { ...s.search, searchModel: s.search.searchModel ? refToName(s.search.searchModel, m) : null },
      contextOverflow: s.contextOverflow,
      contextLimits: mapKeys(s.contextLimits, (k) => refToName(k, m)),
      contextCompressAt: s.contextCompressAt, contextCompressTarget: s.contextCompressTarget,
      defaultContextLength: s.defaultContextLength,
    },
    projects, presets, benchSets,
  };
}

export function serializeExport(userId: string, format: "json" | "yaml"): { body: string; type: string; filename: string } {
  const cfg = buildExport(userId);
  if (format === "yaml") return { body: YAML.stringify(cfg), type: "application/yaml; charset=utf-8", filename: "omnichat-config.yaml" };
  return { body: JSON.stringify(cfg, null, 2) + "\n", type: "application/json; charset=utf-8", filename: "omnichat-config.json" };
}

/* ---------------- import ---------------- */

export interface ImportResult {
  created: { projects: number; presets: number; benchSets: number };
  updated: { projects: number; presets: number; benchSets: number; settings: number };
  removed?: { projects: number; presets: number; benchSets: number };
  skipped: string[];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (m: string, status = 400) => new AuthError(m, status);
const MAX_ENTRIES = 500;

export function parseConfig(format: unknown, content: unknown): any {
  if (format !== "json" && format !== "yaml") throw bad("format must be json or yaml");
  if (typeof content !== "string") throw bad("content must be a string");
  if (Buffer.byteLength(content, "utf8") > CONFIG_LIMIT) throw bad("config is larger than 1 MB", 413);
  let doc: unknown;
  try {
    doc = format === "json" ? JSON.parse(content) : YAML.parse(content, { maxAliasCount: 50 });
  } catch (e) {
    throw bad(`invalid ${format}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  if (!isObj(doc)) throw bad("config must be an object");
  if (doc.version !== undefined && doc.version !== 1) throw bad("unsupported config version (expected 1)");
  for (const k of ["projects", "presets", "benchSets"]) {
    if (doc[k] !== undefined && doc[k] !== null && !Array.isArray(doc[k])) throw bad(`${k} must be an array`);
  }
  if (doc.settings !== undefined && doc.settings !== null && !isObj(doc.settings)) throw bad("settings must be an object");
  return doc;
}

const SETTING_KEYS = [
  "systemPrompt", "effort", "params", "modelParams", "tools", "searchMode", "autoTitle", "titleModel", "search", "titleEvery", "contextOverflow", "contextLimits",
  "contextCompressAt", "contextCompressTarget", "defaultContextLength",
] as const;
/** Keys where null is not a valid value (merge and replace both skip it). */
const NOT_NULLABLE = ["searchMode", "search", "autoTitle", "titleEvery", "contextOverflow", "contextCompressTarget"];

/**
 * Applies a parsed config for the calling user. The projects / presets / settings go through the real PUT / DELETE endpoints
 * (app.inject with the caller's Authorization header), so validation and broadcasts are identical to normal edits.
 */
export async function importConfig(app: FastifyInstance, authorization: string, userId: string, doc: any, mode: "merge" | "replace"): Promise<ImportResult> {
  const res: ImportResult = {
    created: { projects: 0, presets: 0, benchSets: 0 }, updated: { projects: 0, presets: 0, benchSets: 0, settings: 0 }, skipped: [],
  };
  const replace = mode === "replace";
  const call = async (method: "PUT" | "DELETE", url: string, payload?: unknown): Promise<{ ok: boolean; error?: string }> => {
    const r = await app.inject({
      method, url, headers: { authorization, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    if (r.statusCode >= 200 && r.statusCode < 300) return { ok: true };
    let msg = r.body;
    try { msg = JSON.parse(r.body)?.error ?? msg; } catch { /* keep */ }
    return { ok: false, error: String(msg).slice(0, 200) };
  };
  const maps = providerMaps(userId);

  // ---- settings ----
  const inS = isObj(doc.settings) ? doc.settings : {};
  const cur = getSettings(userId);
  for (const key of SETTING_KEYS) {
    if (!(key in inS)) continue;
    let value: any = inS[key];
    if (value === undefined) continue;
    if (value === null && !replace) continue; // merge: an unset value in the file keeps the local one
    if (value === null && NOT_NULLABLE.includes(key)) continue; // not nullable
    if (key === "titleModel" && value !== null) {
      const id = typeof value === "string" ? refToId(value, maps) : null;
      if (!id) { res.skipped.push(`settings.titleModel: unknown provider in "${String(value).slice(0, 80)}"`); continue; }
      value = id;
    }
    if (key === "search" && value !== null) {
      if (!isObj(value)) { res.skipped.push("settings.search: must be an object"); continue; }
      const v: Record<string, unknown> = { ...value };
      if (typeof v.searchModel === "string") {
        const id = refToId(v.searchModel, maps);
        if (id) v.searchModel = id;
        else { res.skipped.push(`settings.search.searchModel: unknown provider in "${v.searchModel.slice(0, 80)}"`); v.searchModel = null; }
      }
      value = v;
    }
    if ((key === "modelParams" || key === "contextLimits") && value !== null) {
      if (!isObj(value)) { res.skipped.push(`settings.${key}: must be an object`); continue; }
      const mapped: Record<string, unknown> = replace ? {} : { ...((cur[key] as Record<string, unknown> | null) ?? {}) };
      for (const [k, v] of Object.entries(value)) {
        const id = refToId(k, maps);
        if (!id) { res.skipped.push(`settings.${key}: unknown provider in "${k.slice(0, 80)}"`); continue; }
        mapped[id] = v;
      }
      value = Object.keys(mapped).length ? mapped : null;
    }
    const r = await call("PUT", "/settings", { [key]: value });
    if (r.ok) res.updated.settings++;
    else res.skipped.push(`settings.${key}: ${r.error}`);
  }

  // ---- projects ----
  const existingProjects = db.prepare("SELECT id, name FROM projects WHERE user_id = ? AND deleted = 0 ORDER BY created_at, rowid").all(userId) as any[];
  const seenProjects = new Set<string>();
  for (const p of ((doc.projects as any[]) ?? []).slice(0, MAX_ENTRIES)) {
    if (!isObj(p) || typeof p.name !== "string" || !p.name.trim()) { res.skipped.push("project without a name"); continue; }
    const name = p.name.trim().slice(0, 200);
    const ex = existingProjects.find((e) => e.name === name);
    const payload: Record<string, unknown> = { name };
    for (const k of ["systemPrompt", "systemMode", "effort", "params", "tools", "searchMode"]) {
      if (!(k in p) || p[k] === undefined) continue;
      if (p[k] === null && ex && !replace) continue;
      payload[k] = p[k];
    }
    if (p.defaultModel != null) {
      const ref = typeof p.defaultModel === "string" ? refToId(p.defaultModel, maps) : null;
      if (ref) {
        const i = ref.indexOf(SEP);
        payload.defaultProviderId = ref.slice(0, i);
        payload.defaultModel = ref.slice(i + SEP.length);
      } else res.skipped.push(`project "${name}": provider of defaultModel "${String(p.defaultModel).slice(0, 80)}" not found; default model not set`);
    } else if (ex && replace) { payload.defaultProviderId = null; payload.defaultModel = null; }
    const id = ex?.id ?? randomUUID();
    const r = await call("PUT", `/projects/${id}`, payload);
    if (!r.ok) { res.skipped.push(`project "${name}": ${r.error}`); continue; }
    seenProjects.add(name);
    if (ex) res.updated.projects++; else res.created.projects++;
  }

  // ---- presets ----
  const existingPresets = db.prepare("SELECT id, name FROM prompt_presets WHERE user_id = ? AND deleted = 0 ORDER BY created_at, rowid").all(userId) as any[];
  const seenPresets = new Set<string>();
  for (const p of ((doc.presets as any[]) ?? []).slice(0, MAX_ENTRIES)) {
    if (!isObj(p) || typeof p.name !== "string" || !p.name.trim() || typeof p.text !== "string") { res.skipped.push("preset needs a name and a text"); continue; }
    const name = p.name.trim().slice(0, 200);
    const ex = existingPresets.find((e) => e.name === name);
    const r = await call("PUT", `/presets/${ex?.id ?? randomUUID()}`, { name, text: p.text });
    if (!r.ok) { res.skipped.push(`preset "${name}": ${r.error}`); continue; }
    seenPresets.add(name);
    if (ex) res.updated.presets++; else res.created.presets++;
  }

  // ---- bench sets ----
  const existingSets = listSets(userId);
  const seenSets = new Set<string>();
  for (const b of ((doc.benchSets as any[]) ?? []).slice(0, MAX_ENTRIES)) {
    const v = validateSetBody(b);
    if (typeof v === "string") { res.skipped.push(`benchSet "${isObj(b) && typeof b.name === "string" ? b.name.slice(0, 80) : "?"}": ${v}`); continue; }
    const ex = existingSets.find((e) => e.name === v.name);
    upsertSet(userId, ex?.id ?? randomUUID(), v);
    seenSets.add(v.name);
    if (ex) res.updated.benchSets++; else res.created.benchSets++;
  }

  // ---- replace: drop what the file does not mention ----
  if (replace) {
    res.removed = { projects: 0, presets: 0, benchSets: 0 };
    if (Array.isArray(doc.projects)) for (const e of existingProjects) {
      if (!seenProjects.has(e.name) && (await call("DELETE", `/projects/${e.id}`)).ok) res.removed.projects++;
    }
    if (Array.isArray(doc.presets)) for (const e of existingPresets) {
      if (!seenPresets.has(e.name) && (await call("DELETE", `/presets/${e.id}`)).ok) res.removed.presets++;
    }
    if (Array.isArray(doc.benchSets)) for (const e of existingSets) {
      if (!seenSets.has(e.name) && deleteSet(userId, e.id)) res.removed.benchSets++;
    }
  }
  return res;
}
